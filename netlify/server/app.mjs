import { getStore } from '@netlify/blobs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const runtime = path.resolve(process.env.VICTIG_RUNTIME_DIR || '.netlify-runtime');
const appDir = path.join(runtime, 'app');
const MAX_UPLOAD = 125 * 1024 * 1024;
// Leave room for map state and Python scratch files in Netlify's 512 MiB /tmp.
export const MAX_REPORT_BYTES = 400 * 1024 * 1024;
const JOB_TIMEOUT_MS = 14 * 60 * 1000;
const CHUNK_BYTES = 2 * 1024 * 1024;
const REPORT_PATHS = new Set(['/admin/upload', '/admin/preview-columns']);
const UPLOAD_PATHS = new Set(['/admin/upload', '/admin/preview-columns', '/admin/upload-desc-doc',
  '/admin/upload-descriptions', '/automation/refresh']);
const MAP_WRITES = new Set(['/admin/update-county', '/admin/update-state', '/admin/site-config',
  '/admin/upload', '/admin/upload-desc-doc', '/admin/upload-descriptions', '/automation/refresh']);
const API_PATHS = new Set([...MAP_WRITES, '/admin/preview-columns', '/api/analytics',
  '/api/analytics/summary', '/api/analytics/backfill-geo', '/api/log/click', '/api/log/visit', '/api/migration/analytics']);
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer' };
const sha = value => createHash('sha256').update(value).digest('hex');
const json = (value, status = 200) => Response.json(value, { status, headers });
const env = key => globalThis.Netlify?.env?.get(key) ?? process.env[key];
let filesPromise;
let uploadHealthPromise;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function safeEqual(a, b) {
  return Boolean(a && b) && timingSafeEqual(createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest());
}

function bundledFiles() {
  return filesPromise ??= Promise.all([
    readFile(path.join(appDir, 'county-data.json'), 'utf8'),
    readFile(path.join(appDir, 'site-config.json'), 'utf8'),
    readFile(path.join(appDir, 'main.py'), 'utf8'),
    readFile(path.join(runtime, 'manifest.json'), 'utf8'),
  ]).then(([data, config, source, manifest]) => ({
    data: JSON.parse(data), config: JSON.parse(config), manifest: JSON.parse(manifest),
    passwordHash: source.match(/PW_HASH\s*=\s*"([a-f0-9]{64})"/)?.[1],
  }));
}

export function storeName(context) {
  // Drafts/previews never write production storage, even when they share a site.
  const suffix = context.deploy?.context === 'production' ? 'production'
    : `preview-${context.deploy?.id || 'local'}`;
  return `victig-map-v1-${suffix}`;
}

async function authenticate(request, targetPath, payload) {
  if (targetPath.startsWith('/automation/') || targetPath.startsWith('/api/migration/')) {
    const expected = env('VICTIG_MAP_INGEST_TOKEN');
    if (!expected) throw new HttpError(503, 'Automated ingestion is disabled');
    const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!safeEqual(token, expected)) throw new HttpError(401, 'Invalid ingestion token');
    return sha(`ingest:${token}`);
  }
  const password = request.headers.get('x-victig-password')
    || new URL(request.url).searchParams.get('password') || payload?.password;
  const expected = (await bundledFiles()).passwordHash;
  if (!password || !safeEqual(sha(password), expected)) throw new HttpError(401, 'Invalid password');
  return sha(`admin:${password}`);
}

export function assertPublic(data) {
  for (const c of Object.values(data?.counties || {})) {
    for (const key of ['client', 'candidate', 'file_num']) {
      if (c.latest && Object.hasOwn(c.latest, key)) throw new HttpError(500, 'Private report fields rejected');
    }
    for (const item of c.outliers || []) {
      for (const key of ['client', 'candidate', 'file_num']) {
        if (Object.hasOwn(item, key)) throw new HttpError(500, 'Private report fields rejected');
      }
    }
  }
}

async function mapSnapshot(store) {
  let snapshot = await store.getWithMetadata('state', { type: 'json' });
  if (snapshot) return snapshot;
  const seed = await bundledFiles();
  assertPublic(seed.data);
  await store.setJSON('state', { data: seed.data, config: seed.config, operations: [] }, { onlyIfNew: true });
  snapshot = await store.getWithMetadata('state', { type: 'json' });
  if (!snapshot) throw new HttpError(503, 'Map storage is unavailable');
  return snapshot;
}

export async function saveState(store, before, state) {
  assertPublic(state.data);
  // Back up exact previous state before publishing the conditional replacement.
  const backup = `backups/${sha(before.etag)}`;
  await store.setJSON(backup, before.data, { onlyIfNew: true,
    metadata: { savedAt: new Date().toISOString(), revision: before.etag } });
  const result = await store.setJSON('state', state, { onlyIfMatch: before.etag });
  if (!result.modified) throw new HttpError(409, 'The map changed while this request was processing. Reload and retry.');
  return result.etag;
}

export async function runPython(payload, mapState, analytics, timeoutMs = 48000) {
  const directory = await mkdtemp(path.join(tmpdir(), 'victig-map-'));
  try {
    const dataDir = path.join(directory, 'data');
    await mkdir(dataDir);
    if (mapState) {
      await writeFile(path.join(dataDir, 'county-data.json'), JSON.stringify(mapState.data));
      await writeFile(path.join(dataDir, 'site-config.json'), JSON.stringify(mapState.config));
    }
    if (analytics) await writeFile(path.join(dataDir, 'analytics.db'), Buffer.from(analytics));
    const input = path.join(directory, 'request.json');
    const output = path.join(directory, 'response.json');
    await writeFile(input, JSON.stringify(payload), { mode: 0o600 });
    const { manifest } = await bundledFiles();
    const pythonRoot = path.join(runtime, 'python', manifest.python);
    const python = process.env.VICTIG_PYTHON || path.join(pythonRoot, 'bin/python3');
    const environment = { ...process.env, DATA_DIR: dataDir,
      VICTIG_MAP_BUILD_ID: manifest.buildId,
      VICTIG_MAP_INGEST_TOKEN: env('VICTIG_MAP_INGEST_TOKEN') || '',
      PYTHONDONTWRITEBYTECODE: '1', TMPDIR: directory };
    if (!process.env.VICTIG_PYTHON) {
      environment.PYTHONHOME = pythonRoot;
      environment.PYTHONPATH = path.join(runtime, 'packages');
      environment.PATH = `${path.join(pythonRoot, 'bin')}:${process.env.PATH || ''}`;
      environment.LD_LIBRARY_PATH = `${path.join(pythonRoot, 'lib')}:${process.env.LD_LIBRARY_PATH || ''}`;
    }
    await new Promise((resolve, reject) => {
      const child = spawn(python, [path.join(appDir, 'bridge.py'), input, output], {
        cwd: appDir, env: environment, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let diagnostic = '';
      child.stderr.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-2000); });
      const timeout = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        reject(new HttpError(504, 'Processing exceeded the time limit. No map changes were saved.'));
      }, timeoutMs);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', code => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else {
          // Do not print request content, source rows, passwords, or raw diagnostics.
          console.error('Python request failed', { code, path: payload.path, diagnosticHash: sha(diagnostic) });
          reject(new HttpError(500, 'The request could not be processed. No map changes were saved.'));
        }
      });
    });
    const response = JSON.parse(await readFile(output, 'utf8'));
    const data = JSON.parse(await readFile(path.join(dataDir, 'county-data.json'), 'utf8'));
    const config = JSON.parse(await readFile(path.join(dataDir, 'site-config.json'), 'utf8'));
    const db = await readFile(path.join(dataDir, 'analytics.db')).catch(() => null);
    return { response, data, config, analytics: db };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function responseFrom(result) {
  return new Response(Buffer.from(result.body, 'base64'), {
    status: result.status, headers: { ...Object.fromEntries(result.headers), ...headers },
  });
}

async function recordUpload(store, spec, context, stage, extra = {}) {
  const { manifest } = await bundledFiles();
  const extension = path.extname(spec.filename).toLowerCase();
  const record = { event: 'report_upload', uploadId: spec.id, stage,
    at: new Date().toISOString(), commit: manifest.commit,
    requestId: context.requestId || null, target: spec.target, bytes: spec.bytes,
    format: ['.csv', '.tsv', '.txt', '.xlsx', '.xlsm', '.xls'].includes(extension) ? extension : 'other', ...extra };
  // Only these explicit fields enter diagnostics, never credentials, the
  // original filename, report rows, raw exceptions, or request bodies.
  (record.status >= 400 ? console.error : console.info)(JSON.stringify(record));
  try { await store.setJSON(`upload-diagnostics/${spec.id}`, record); }
  catch { console.error(JSON.stringify({ event: 'upload_diagnostic_save_failed', uploadId: spec.id })); }
}

async function dispatch(request, context, store, body, target, operationId, report) {
  const url = target || new URL(request.url);
  if (!API_PATHS.has(url.pathname)) throw new HttpError(404, 'Not found');
  let payload;
  if (request.headers.get('content-type')?.includes('application/json') && body.length) {
    try { payload = JSON.parse(body.toString()); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }
  const analyticsRoute = url.pathname.startsWith('/api/analytics') || url.pathname.startsWith('/api/log/') || url.pathname.startsWith('/api/migration/');
  if (!url.pathname.startsWith('/api/log/')) await authenticate(request, url.pathname, payload);
  if (MAP_WRITES.has(url.pathname) && request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const map = analyticsRoute ? null : await mapSnapshot(store);
  const previousOperation = operationId && map?.data.operations?.find(op => op.id === operationId);
  if (previousOperation) return responseFrom(previousOperation.response);
  const geo = context.geo || {};
  const location = [geo.city, geo.subdivision?.name].filter(Boolean).join(', ');
  const input = { path: url.pathname, query: url.search.slice(1), method: request.method,
    headers: [...request.headers].filter(([key]) => !['host', 'content-length', 'x-forwarded-for'].includes(key)),
    body: body.toString('base64'), ip: context.ip || '127.0.0.1', location };
  if (report) input.report = { path: report.path, filename: report.filename };
  input.headers.push(['x-forwarded-for', input.ip]);
  for (let attempt = 0; attempt < 4; attempt++) {
    const db = analyticsRoute ? await store.getWithMetadata('analytics', { type: 'arrayBuffer' }) : null;
    const output = await runPython(input, map?.data, db?.data, report?.timeoutMs);
    if (output.response.status < 400) {
      if (map && MAP_WRITES.has(url.pathname)) {
        const operations = [...(map.data.operations || []), ...(operationId ? [{ id: operationId, response: output.response }] : [])].slice(-40);
        await saveState(store, map, { data: output.data, config: output.config, operations });
      }
      if (analyticsRoute && output.analytics && (!db || !Buffer.from(db.data).equals(output.analytics))) {
        const saved = await store.set('analytics', output.analytics,
          db ? { onlyIfMatch: db.etag } : { onlyIfNew: true });
        if (!saved.modified) continue;
      }
    }
    return responseFrom(output.response);
  }
  throw new HttpError(409, 'Analytics changed concurrently. Please retry.');
}

async function uploadRequest(request, context, store, body) {
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 2 && request.method === 'POST') {
    let spec;
    try { spec = JSON.parse(body.toString()); } catch { throw new HttpError(400, 'Invalid upload metadata'); }
    const target = new URL(spec.target, 'https://upload.invalid');
    if (!UPLOAD_PATHS.has(target.pathname) || target.origin !== 'https://upload.invalid') throw new HttpError(400, 'Invalid upload target');
    const owner = await authenticate(request, target.pathname);
    if (spec.protocol === 2) {
      if (!REPORT_PATHS.has(target.pathname) || target.search || !Number.isSafeInteger(spec.bytes) || spec.bytes < 1
        || typeof spec.filename !== 'string' || !spec.filename || spec.filename.length > 255) {
        throw new HttpError(400, 'Invalid report upload metadata');
      }
      if (spec.bytes > MAX_REPORT_BYTES) throw new HttpError(413, 'This Netlify site supports reports up to 400 MiB. Larger reports need local processing.');
      const id = randomUUID();
      const metadata = { protocol: 2, target: target.pathname, filename: path.basename(spec.filename),
        bytes: spec.bytes, owner, id, chunks: Math.ceil(spec.bytes / CHUNK_BYTES),
        expires: Date.now() + 30 * 60 * 1000, phase: 'uploading' };
      await store.setJSON(`uploads/${id}/metadata`, metadata, { onlyIfNew: true });
      await recordUpload(store, metadata, context, 'uploading');
      return json({ id, chunkBytes: CHUNK_BYTES, chunks: metadata.chunks });
    }
    if (!Number.isSafeInteger(spec.bytes) || spec.bytes < 1 || spec.bytes > MAX_UPLOAD
      || !/^[a-f0-9]{64}$/.test(spec.sha256) || !spec.contentType?.startsWith('multipart/form-data; boundary=')) {
      throw new HttpError(400, 'Invalid upload size, digest, or format');
    }
    const id = randomUUID();
    const metadata = { ...spec, target: target.pathname + target.search, owner, id,
      chunks: Math.ceil(spec.bytes / CHUNK_BYTES), expires: Date.now() + 30 * 60 * 1000, phase: 'uploading' };
    await store.setJSON(`uploads/${id}/metadata`, metadata, { onlyIfNew: true });
    return json({ id, chunkBytes: CHUNK_BYTES, chunks: metadata.chunks });
  }
  const [, , id, part] = segments;
  if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new HttpError(404, 'Upload not found');
  const key = `uploads/${id}/metadata`;
  const snapshot = await store.getWithMetadata(key, { type: 'json' });
  if (!snapshot) throw new HttpError(404, 'Upload not found');
  const spec = snapshot.data;
  const owner = await authenticate(request, new URL(spec.target, url).pathname);
  if (!safeEqual(owner, spec.owner)) throw new HttpError(403, 'Upload belongs to another session');
  if (spec.expires < Date.now()) throw new HttpError(410, 'Upload expired. Please upload the file again.');
  if (spec.protocol === 2 && part === 'status' && request.method === 'GET') {
    if (spec.phase === 'complete') return responseFrom(spec.response);
    if (spec.phase === 'processing' && spec.leaseUntil <= Date.now()) {
      throw new HttpError(504, 'Report processing exceeded the hosting time limit. Reload the map to check its current data before retrying.');
    }
    return json({ id, phase: spec.phase }, 202);
  }
  if (/^\d+$/.test(part || '') && request.method === 'PUT') {
    const index = Number(part);
    if (spec.phase !== 'uploading' || index >= spec.chunks || body.length !== Math.min(CHUNK_BYTES, spec.bytes - index * CHUNK_BYTES)) {
      throw new HttpError(400, 'Invalid upload chunk');
    }
    const chunkKey = `uploads/${id}/part-${index}`;
    if (spec.protocol === 2 && !safeEqual(request.headers.get('x-victig-chunk-sha256'), sha(body))) {
      throw new HttpError(400, 'Upload chunk integrity check failed');
    }
    const result = await store.set(chunkKey, body, { onlyIfNew: true, metadata: { sha256: sha(body) } });
    if (!result.modified) {
      const existing = await store.getWithMetadata(chunkKey, { type: 'arrayBuffer' });
      if (!existing || sha(Buffer.from(existing.data)) !== sha(body)) throw new HttpError(409, 'Upload chunk differs from the saved chunk');
    }
    return json({ ok: true, index });
  }
  if (part !== 'complete' || request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (spec.phase === 'complete') return responseFrom(spec.response);
  if (spec.protocol === 2) {
    let digest;
    try { digest = JSON.parse(body.toString()).sha256; } catch {}
    if (!/^[a-f0-9]{64}$/.test(digest || '')) throw new HttpError(400, 'Invalid upload digest');
    if (spec.phase !== 'uploading' && !safeEqual(digest, spec.sha256)) throw new HttpError(409, 'Upload digest differs from the queued report');
    if (spec.phase === 'uploading') {
      const queued = await store.setJSON(key, { ...spec, sha256: digest, phase: 'queued',
        expires: Date.now() + 30 * 60 * 1000 }, { onlyIfMatch: snapshot.etag });
      if (!queued.modified) throw new HttpError(409, 'Upload changed. Retry completion.');
      await recordUpload(store, spec, context, 'queued');
    }
    return json({ id, phase: spec.phase === 'uploading' ? 'queued' : spec.phase }, 202);
  }
  if (spec.phase === 'processing' && spec.leaseUntil > Date.now()) throw new HttpError(409, 'Upload is still processing');
  const lease = await store.setJSON(key, { ...spec, phase: 'processing', leaseUntil: Date.now() + 60000 }, { onlyIfMatch: snapshot.etag });
  if (!lease.modified) throw new HttpError(409, 'Upload is already processing');
  try {
    const pieces = [];
    for (let i = 0; i < spec.chunks; i++) {
      const piece = await store.get(`uploads/${id}/part-${i}`, { type: 'arrayBuffer' });
      if (!piece) throw new HttpError(400, 'The upload is incomplete');
      pieces.push(Buffer.from(piece));
    }
    const combined = Buffer.concat(pieces);
    if (combined.length !== spec.bytes || sha(combined) !== spec.sha256) throw new HttpError(400, 'Upload integrity check failed');
    const target = new URL(spec.target, url);
    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.set('content-type', spec.contentType);
    const forwarded = new Request(target, { method: 'POST', headers: forwardedHeaders });
    const response = await dispatch(forwarded, context, store, combined, target, id);
    const savedResponse = { status: response.status, headers: [...response.headers], body: Buffer.from(await response.arrayBuffer()).toString('base64') };
    await store.setJSON(key, { ...spec, phase: 'complete', response: savedResponse }, { onlyIfMatch: lease.etag });
    for (let i = 0; i < spec.chunks; i++) await store.delete(`uploads/${id}/part-${i}`);
    return responseFrom(savedResponse);
  } catch (error) {
    await store.setJSON(key, { ...spec, phase: 'uploading' }, { onlyIfMatch: lease.etag });
    throw error;
  }
}

// Called by a background function with the original credential in its request,
// never saved in Blobs. Every invocation rechecks ownership and takes a lease.
export async function processUpload(request, context, providedStore) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const { id } = await request.json();
  if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new HttpError(404, 'Upload not found');
  const store = providedStore || getStore({ name: storeName(context), consistency: 'strong' });
  const key = `uploads/${id}/metadata`;
  const snapshot = await store.getWithMetadata(key, { type: 'json' });
  const spec = snapshot?.data;
  if (!spec || spec.protocol !== 2) throw new HttpError(404, 'Upload not found');
  const owner = await authenticate(request, spec.target);
  if (!safeEqual(owner, spec.owner)) throw new HttpError(403, 'Upload belongs to another session');
  if (spec.expires < Date.now()) throw new HttpError(410, 'Upload expired');
  if (spec.phase === 'complete' || (spec.phase === 'processing' && spec.leaseUntil > Date.now())) return;
  if (!['queued', 'processing'].includes(spec.phase)) throw new HttpError(409, 'Upload is not ready');
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  const lease = await store.setJSON(key, { ...spec, phase: 'processing', leaseUntil: deadline + 60000 },
    { onlyIfMatch: snapshot.etag });
  if (!lease.modified) return;
  const started = Date.now();
  let stage = 'assembling';
  await recordUpload(store, spec, context, stage);
  let directory;
  let response;
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'victig-report-'));
    const reportPath = path.join(directory, 'report');
    const file = await open(reportPath, 'wx', 0o600);
    const digest = createHash('sha256');
    try {
      for (let index = 0; index < spec.chunks; index++) {
        if (Date.now() >= deadline) throw new HttpError(504, 'Report download exceeded the processing time limit. No map changes were saved.');
        const chunk = await store.getWithMetadata(`uploads/${id}/part-${index}`, { type: 'arrayBuffer' });
        if (!chunk) throw new HttpError(400, 'The upload is incomplete. Please upload the file again.');
        const bytes = Buffer.from(chunk.data);
        const hash = sha(bytes);
        if (bytes.length !== Math.min(CHUNK_BYTES, spec.bytes - index * CHUNK_BYTES)
          || !safeEqual(hash, chunk.metadata?.sha256)) throw new HttpError(400, 'Upload integrity check failed');
        digest.update(hash);
        await file.writeFile(bytes);
      }
    } finally { await file.close(); }
    if (!safeEqual(digest.digest('hex'), spec.sha256)) throw new HttpError(400, 'Upload integrity check failed');
    const target = new URL(spec.target, request.url);
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new HttpError(504, 'Report download exceeded the processing time limit. No map changes were saved.');
    stage = 'processing';
    await recordUpload(store, spec, context, stage);
    response = await dispatch(new Request(target, { method: 'POST', headers: request.headers }),
      context, store, Buffer.alloc(0), target, id, { path: reportPath, filename: spec.filename, timeoutMs });
  } catch (error) {
    response = json({ detail: error.status ? error.message : 'Report processing failed. Reload the map to check its current data before retrying.' }, error.status || 500);
    response.headers.set('X-Victig-Error-Code', error.status ? `HTTP_${error.status}` : 'REPORT_WORKER_FAILED');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  let errorCode, frames;
  if (!response.ok) {
    errorCode = response.headers.get('x-victig-error-code') || `HTTP_${response.status}`;
    if (!/^[A-Za-z0-9_]{1,80}$/.test(errorCode)) errorCode = 'REPORT_PROCESSING_FAILED';
    try { frames = JSON.parse(response.headers.get('x-victig-error-frames') || '[]'); } catch { frames = []; }
    frames = Array.isArray(frames) ? frames.filter(value => typeof value === 'string'
      && /^[A-Za-z0-9_.-]+\.py:\d+:[\w<>]+$/.test(value)).slice(-4) : [];
    const document = await response.json();
    response = json({ ...document, uploadId: id, stage, errorCode,
      detail: `${document.detail || 'Report processing failed.'} Upload ID: ${id}` }, response.status);
  }
  await recordUpload(store, spec, context, response.ok ? 'complete' : stage,
    { status: response.status, elapsedMs: Date.now() - started, ...(errorCode ? { errorCode, frames } : {}) });
  const savedResponse = { status: response.status, headers: [...response.headers],
    body: Buffer.from(await response.arrayBuffer()).toString('base64') };
  const saved = await store.setJSON(key, { ...spec, phase: 'complete', response: savedResponse }, { onlyIfMatch: lease.etag });
  // Do not delete a replacement worker's input if our lease was superseded.
  if (saved.modified) {
    for (let index = 0; index < spec.chunks; index += 8) {
      await Promise.all(Array.from({ length: Math.min(8, spec.chunks - index) }, (_, offset) =>
        store.delete(`uploads/${id}/part-${index + offset}`)));
    }
  }
}

export async function handle(request, context, providedStore) {
  try {
    const store = providedStore || getStore({ name: storeName(context), consistency: 'strong' });
    const url = new URL(request.url);
    if (url.pathname === '/api/version' && request.method === 'GET') {
      const { manifest } = await bundledFiles();
      return json({ version: manifest.buildId, commit: manifest.commit, has_analytics: true,
        hosting: 'netlify', storage: storeName(context) });
    }
    if (url.pathname === '/api/upload-health' && request.method === 'GET') {
      // Cache per function instance. Fixed tiny fixtures, no request input,
      // credentials, Blobs reads/writes, or calls to the publishing path.
      uploadHealthPromise ??= runPython({ path: '/internal/upload-self-test', headers: [] }, null, null)
        .then(output => ({ ok: output.response.status === 200 }))
        .catch(() => ({ ok: false }));
      const result = await uploadHealthPromise;
      const { manifest } = await bundledFiles();
      return json({ ...result, commit: manifest.commit,
        checks: ['csv_import', 'xlsx_import', 'aggregated_values'], writesLiveData: false }, result.ok ? 200 : 503);
    }
    if (url.pathname === '/api/my-ip' && request.method === 'GET') return json({ ip: context.ip });
    if (['/county-data.json', '/site-config.json'].includes(url.pathname) && ['GET', 'HEAD'].includes(request.method)) {
      const snapshot = await mapSnapshot(store);
      assertPublic(snapshot.data.data);
      return new Response(request.method === 'HEAD' ? null : JSON.stringify(
        url.pathname === '/county-data.json' ? snapshot.data.data : snapshot.data.config),
      { headers: { ...headers, 'Content-Type': 'application/json', ETag: snapshot.etag } });
    }
    const body = Buffer.from(await request.arrayBuffer());
    if (body.length > MAX_UPLOAD) throw new HttpError(413, 'Upload exceeds the maximum size');
    if (url.pathname === '/api/migration/analytics' && request.method === 'POST') {
      await authenticate(request, url.pathname);
      if (!body.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw new HttpError(400, 'Expected a SQLite database');
      return await dispatch(request, context, store, body);
    }
    if (url.pathname.startsWith('/api/uploads')) return await uploadRequest(request, context, store, body);
    return await dispatch(request, context, store, body);
  } catch (error) {
    const status = error.status || 500;
    if (!error.status) console.error('Map adapter error', { name: error.name, code: error.code });
    return json({ detail: status === 500 && !error.status ? 'The request failed. No map changes were saved.' : error.message }, status);
  }
}
