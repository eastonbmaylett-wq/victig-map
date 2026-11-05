"""Loopback-only admin: process locally, then conditionally publish public data."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from refresh_guard import validate_transition, validate_freshness

STATE = Path(os.environ.get('VICTIG_LOCAL_HOME', Path.home() / 'Library/Application Support/VICTIG TAT Map'))
STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
STATE.chmod(0o700)
PUBLIC = os.environ.get('VICTIG_LOCAL_PUBLIC_URL', 'https://precious-dolphin-3f8f85.netlify.app').rstrip('/')
NODE = os.environ.get('VICTIG_LOCAL_NODE', shutil.which('node') or '/opt/homebrew/bin/node')
PW_HASH = re.search(r'PW_HASH\s*=\s*"([a-f0-9]{64})"', (ROOT / 'main.py').read_text())[1]
WRITES = {'/admin/update-county', '/admin/update-state', '/admin/site-config', '/admin/upload',
          '/admin/upload-desc-doc', '/admin/upload-descriptions'}
ANALYTICS = {'/api/analytics', '/api/analytics/summary', '/api/analytics/backfill-geo', '/api/my-ip'}
ASSETS = {'d3.min.js', 'topojson-client.min.js', 'counties-10m.json', 'victig-logo.png', 'victig-logo-white.png'}
MAX_BODY = 125 * 1024 * 1024
LOCK = asyncio.Lock()
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost'])
app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')


@app.middleware('http')
async def local_boundary(request, call_next):
    origin = request.headers.get('origin')
    if request.method not in {'GET', 'HEAD'} and (
        request.headers.get('sec-fetch-site') == 'cross-site'
        or (origin and origin != str(request.base_url).rstrip('/'))
    ):
        return JSONResponse({'detail': 'Open the admin on this Mac to make changes.'}, status_code=403)
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


def password_for(request, body=b''):
    password = request.headers.get('x-victig-password') or request.query_params.get('password')
    if not password and request.headers.get('content-type', '').startswith('application/json'):
        try:
            password = json.loads(body).get('password')
        except (ValueError, AttributeError):
            pass
    if not isinstance(password, str) or not hmac.compare_digest(hashlib.sha256(password.encode()).hexdigest(), PW_HASH):
        raise HTTPException(401, 'Invalid password')
    return password


async def command(*args, timeout=240):
    child = await asyncio.create_subprocess_exec(*map(str, args), cwd=ROOT,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, 'PYTHONPATH': str(ROOT), 'PYTHONDONTWRITEBYTECODE': '1'})
    try:
        stdout, stderr = await asyncio.wait_for(child.communicate(), timeout)
    except asyncio.TimeoutError:
        child.kill()
        await child.wait()
        raise HTTPException(504, 'Processing timed out. Publication was not verified; reload before retrying.')
    if child.returncode:
        try:
            detail = json.loads(stderr.decode().strip().splitlines()[-1])
        except (ValueError, IndexError):
            detail = {'status': 502, 'detail': 'Local processing failed. No verified publication was completed.'}
        raise HTTPException(detail.get('status', 502), detail.get('detail', 'Local processing failed.'))
    return json.loads(stdout) if stdout.strip() else None


async def snapshot(destination):
    await command(NODE, ROOT / 'local_admin/store.mjs', 'snapshot', destination)
    return json.loads(destination.read_text())


async def process_request(request, body, directory, before):
    data_dir = directory / 'data'
    data_dir.mkdir(mode=0o700)
    for name, key in [('county-data.json', 'data'), ('site-config.json', 'config')]:
        (data_dir / name).write_text(json.dumps(before['data'][key]))
    payload = {'method': request.method, 'path': request.url.path, 'query': request.url.query,
        'headers': [(k, v) for k, v in request.headers.items() if k in {'content-type', 'x-victig-password'}],
        'body': base64.b64encode(body).decode(), 'ip': '127.0.0.1'}
    request_path, response_path = directory / 'request.json', directory / 'response.json'
    request_path.write_text(json.dumps(payload))
    # Run the existing processor in a separate process and private temporary data directory.
    child = await asyncio.create_subprocess_exec(sys.executable, str(ROOT / 'netlify/bridge.py'),
        str(request_path), str(response_path), cwd=ROOT,
        env={**os.environ, 'DATA_DIR': str(data_dir), 'PYTHONPATH': str(ROOT),
             'PYTHONDONTWRITEBYTECODE': '1', 'TMPDIR': str(directory)},
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
    try:
        await asyncio.wait_for(child.wait(), 240)
    except asyncio.TimeoutError:
        import signal
        os.killpg(child.pid, signal.SIGKILL)
        await child.wait()
        raise HTTPException(504, 'The local processor timed out. Nothing was published.')
    if child.returncode:
        raise HTTPException(500, 'The local processor failed. Nothing was published.')
    result = json.loads(response_path.read_text())
    candidate = {'data': json.loads((data_dir / 'county-data.json').read_text()),
                 'config': json.loads((data_dir / 'site-config.json').read_text())}
    return result, candidate


async def remote(path, *, password=None, method='GET', params=None):
    headers = {'X-Victig-Password': password} if password else {}
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.request(method, PUBLIC + path, headers=headers, params=params)
    except httpx.HTTPError:
        raise HTTPException(503, 'The public map is unavailable. Check the internet connection.')
    return Response(response.content, status_code=response.status_code,
                    media_type=response.headers.get('content-type', 'application/json'))


@app.get('/local/status')
async def status():
    latest = STATE / 'last-publish.json'
    return {'local': True, 'publicURL': PUBLIC, 'lastPublish': json.loads(latest.read_text()) if latest.exists() else None}


@app.get('/api/version')
async def version():
    return {'version': 'mac-mini-' + hashlib.sha256((ROOT / 'static/map.js').read_bytes()).hexdigest()[:12]}


@app.get('/local-client.js')
async def local_client():
    return FileResponse(ROOT / 'local_admin/client.js', media_type='application/javascript')


@app.api_route('/{route:path}', methods=['GET', 'HEAD', 'POST'])
async def handle(route: str, request: Request):
    path = '/' + route
    if request.method in {'GET', 'HEAD'}:
        pages = {'/': 'index.html', '/admin': 'admin.html', '/admin.html': 'admin.html',
                 '/embed': 'embed.html', '/analytics': 'analytics.html'}
        if path in pages:
            local_script = f'<script>window.VICTIG_PUBLIC_MAP_ORIGIN={json.dumps(PUBLIC)};</script><script src="/local-client.js"></script>'
            html = (ROOT / pages[path]).read_text().replace('<head>', '<head>\n' + local_script, 1)
            html = html.replace('href="/" target="_blank"', f'href="{PUBLIC}/" target="_blank"')
            return Response(html, media_type='text/html')
        if route in ASSETS:
            return FileResponse(ROOT / route)
        if path in {'/county-data.json', '/site-config.json'}:
            return await remote(path)
    if path.startswith('/api/log/'):
        return {'ok': True, 'localPreview': True}
    if path in ANALYTICS:
        password = password_for(request) if path != '/api/my-ip' else None
        params = [(k, v) for k, v in request.query_params.multi_items() if k != 'password']
        return await remote(path, password=password, method=request.method, params=params)
    if path not in WRITES | {'/admin/preview-columns'} or request.method != 'POST':
        raise HTTPException(404, 'Not found')
    if request.headers.get('content-length', '').isdigit() and int(request.headers['content-length']) > MAX_BODY:
        raise HTTPException(413, 'Upload exceeds 125 MB')
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY:
            raise HTTPException(413, 'Upload exceeds 125 MB')
        chunks.append(chunk)
    body = b''.join(chunks)
    password_for(request, body)
    async with LOCK:
        with tempfile.TemporaryDirectory(prefix='operation-', dir=STATE) as temp:
            directory = Path(temp)
            before_path = directory / 'before.json'
            before = await snapshot(before_path)
            result, candidate = await process_request(request, body, directory, before)
            if result['status'] >= 400 or path == '/admin/preview-columns':
                return Response(base64.b64decode(result['body']), status_code=result['status'], media_type='application/json')
            try:
                validate_transition(before['data']['data'], candidate['data'])
                if set(before['data']['data']['counties']) != set(candidate['data']['counties']):
                    raise ValueError('The county inventory changed')
                if path == '/admin/upload':
                    validate_freshness(candidate['data'], max_age_days=3)
            except ValueError as error:
                raise HTTPException(400, str(error) + '. Nothing was published.')
            candidate_path = directory / 'candidate.json'
            candidate_path.write_text(json.dumps(candidate))
            archive = STATE / 'backups' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8])
            archive.mkdir(parents=True, mode=0o700)
            shutil.copy2(before_path, archive / 'before.json')
            shutil.copy2(candidate_path, archive / 'candidate.json')
            publication = await command(NODE, ROOT / 'local_admin/store.mjs', 'publish', before_path, candidate_path, timeout=90)
            publication['publishedAt'] = datetime.now(timezone.utc).isoformat()
            publication['publicURL'] = PUBLIC
            (STATE / 'last-publish.json').write_text(json.dumps(publication))
            (archive / 'result.json').write_text(json.dumps(publication))
            output = json.loads(base64.b64decode(result['body']))
            output.update({'publish': publication, 'message': 'Processed on this Mac. Public map verified.'})
            return output
