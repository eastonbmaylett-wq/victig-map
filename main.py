from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
import subprocess, shutil, os, hashlib, json, csv, io
from pathlib import Path

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)  # disable API docs

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

BASE = Path(__file__).parent
DATA_FILE = BASE / "county-data.json"
PW_HASH   = "b3121997c76507dc7adcf3ca13ee60d519cbc3c72a176527e8ba575fc13f3406"

# ── Security headers ──────────────────────────────────────────────────────
SECURITY_HEADERS = {
    "X-Content-Type-Options":    "nosniff",
    "X-XSS-Protection":          "1; mode=block",
    "Referrer-Policy":           "no-referrer",
    "Permissions-Policy":        "geolocation=(), camera=(), microphone=()",
    # X-Frame-Options intentionally omitted - map is designed to be embedded in TazWorks/InstaScreen
}

def secure(response: Response):
    for k, v in SECURITY_HEADERS.items():
        response.headers[k] = v
    return response

# ── Auth ──────────────────────────────────────────────────────────────────
def check_auth(password: str):
    if not password:
        raise HTTPException(status_code=401, detail="Password required")
    h = hashlib.sha256(password.encode()).hexdigest()
    if h != PW_HASH:
        raise HTTPException(status_code=401, detail="Invalid password")

# ── Block any direct file access not explicitly allowed ───────────────────
BLOCKED_EXTENSIONS = {".py", ".json", ".csv", ".txt", ".toml", ".env", ".sh"}
BLOCKED_FILES      = {"requirements.txt", "Procfile", "uploaded.csv",
                      "simplemaps-base.json", "process.py", "main.py"}

@app.middleware("http")
async def block_raw_files(request: Request, call_next):
    path = request.url.path.lstrip("/")
    # Block direct access to sensitive files
    if path in BLOCKED_FILES:
        return JSONResponse(status_code=404, content={"detail": "Not found"})
    # Block any file extension that shouldn't be public
    suffix = Path(path).suffix.lower()
    ALLOWED_FILES = {"county-data.json", "counties-10m.json", "d3.min.js", "topojson-client.min.js"}
    if suffix in BLOCKED_EXTENSIONS and path not in ALLOWED_FILES:
        return JSONResponse(status_code=404, content={"detail": "Not found"})
    response = await call_next(request)
    for k, v in SECURITY_HEADERS.items():
        response.headers[k] = v
    return response

# ── Public routes ─────────────────────────────────────────────────────────
@app.get("/")
def root():
    return FileResponse(BASE / "index.html", media_type="text/html",
                        headers={"Cache-Control": "no-store, no-cache, must-revalidate"})

@app.get("/county-data.json")
def get_data():
    """Serve only the sanitized county stats - no PII."""
    return FileResponse(
        DATA_FILE,
        media_type="application/json",
        headers={"Cache-Control": "no-cache"}
    )

@app.get("/counties-10m.json")
def get_topo():
    return FileResponse(
        BASE / "counties-10m.json",
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=86400"}
    )

@app.get("/d3.min.js")
def get_d3():
    return FileResponse(
        BASE / "d3.min.js",
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=86400"}
    )

@app.get("/topojson-client.min.js")
def get_topojson():
    return FileResponse(
        BASE / "topojson-client.min.js",
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=86400"}
    )


# ── Admin routes (password required for all writes) ───────────────────────
@app.get("/admin")
def admin_page():
    return FileResponse(BASE / "admin.html", media_type="text/html",
                        headers={"Cache-Control": "no-store, no-cache, must-revalidate"})

@app.get("/embed")
def embed_page():
    """Iframe-optimised view - no header, full-bleed map."""
    return FileResponse(BASE / "embed.html", media_type="text/html",
                        headers={"Cache-Control": "no-store, no-cache"})

@app.post("/admin/update-county")
async def update_county(payload: dict):
    check_auth(payload.get("password", ""))
    fips        = payload.get("fips")
    status      = payload.get("status", "ok")
    description = payload.get("description", "")
    if not fips:
        raise HTTPException(status_code=400, detail="fips required")
    if status not in ("ok", "delay", "high_tat", "significant"):
        raise HTTPException(status_code=400, detail="invalid status")
    with open(DATA_FILE) as f:
        data = json.load(f)
    if fips not in data["counties"]:
        raise HTTPException(status_code=404, detail="County not found")
    data["counties"][fips]["status"]          = status
    data["counties"][fips]["description"]     = description
    data["counties"][fips]["_admin_override"] = True
    with open(DATA_FILE, "w") as f:
        json.dump(data, f)
    return {"ok": True}

@app.post("/admin/upload")
async def upload_csv(password: str, file: UploadFile = File(...)):
    check_auth(password)
    name = (file.filename or "").lower()
    raw = await file.read()
    tmp = Path("/tmp/victig_upload.csv")

    if name.endswith(".xlsx") or name.endswith(".xlsm"):
        try:
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
            # Pick the main data sheet (prefer sheet with most rows / matching name)
            ws = None
            for sname in wb.sheetnames:
                n = sname.lower()
                if 'turnaround' in n or ('search' in n and 'tat' not in n) or \
                   ('tat' in n and 'fastest' not in n and 'outlier' not in n):
                    ws = wb[sname]; break
            if ws is None:
                # Fall back to largest sheet by row count
                best, best_rows = None, 0
                for sname in wb.sheetnames:
                    s = wb[sname]
                    r = s.max_row or 0
                    if r > best_rows:
                        best_rows, best = r, sname
                ws = wb[best] if best else wb.active
            rows = list(ws.iter_rows(values_only=True))
            with open(tmp, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                for row in rows:
                    writer.writerow(["" if v is None else str(v) for v in row])
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Excel parse error: {e}")
    elif name.endswith(".xls"):
        raise HTTPException(status_code=400, detail="Old .xls format not supported - please Save As .xlsx in Excel first")
    elif name.endswith(".tsv") or name.endswith(".txt"):
        # Tab-separated → convert to comma CSV
        text = raw.decode("utf-8-sig", errors="replace")
        reader = csv.reader(io.StringIO(text), delimiter="\t")
        with open(tmp, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            for row in reader:
                writer.writerow(row)
    else:
        # Treat as CSV (covers .csv and any unknown format)
        with open(tmp, "wb") as f:
            f.write(raw)

    result = subprocess.run(
        ["python3", str(BASE / "process.py"), str(tmp)],
        capture_output=True, text=True, cwd=str(BASE)
    )
    tmp.unlink(missing_ok=True)
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "Unknown error")[:800]
        raise HTTPException(status_code=500, detail=err)
    return {"ok": True, "message": result.stdout.strip() or "Map data updated successfully"}

@app.post("/admin/preview-columns")
async def preview_columns(password: str, file: UploadFile = File(...)):
    """Return the column headers + first 3 rows of an uploaded file without processing it."""
    check_auth(password)
    name = file.filename or ""
    raw = await file.read()
    rows = []
    try:
        if name.endswith(".xlsx"):
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
            ws = None
            for sname in wb.sheetnames:
                n = sname.lower()
                if 'turnaround' in n or ('search' in n and 'tat' not in n) or \
                   ('tat' in n and 'fastest' not in n and 'outlier' not in n):
                    ws = wb[sname]; break
            if ws is None:
                best, best_rows = None, 0
                for sname in wb.sheetnames:
                    s = wb[sname]
                    r = s.max_row or 0
                    if r > best_rows:
                        best_rows, best = r, sname
                ws = wb[best] if best else wb.active
            rows = [list(r) for r in list(ws.iter_rows(values_only=True))[:6]]
        else:
            text = raw.decode("utf-8-sig", errors="replace")
            reader = csv.reader(io.StringIO(text))
            rows = [r for _, r in zip(range(6), reader)]
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"rows": rows}

@app.post("/admin/update-state")
async def update_state(payload: dict):
    check_auth(payload.get("password", ""))
    state       = payload.get("state", "").upper()
    status      = payload.get("status", "ok")
    description = payload.get("description", "")
    if not state:
        raise HTTPException(status_code=400, detail="state required")
    if status not in ("ok", "delay", "high_tat", "significant"):
        raise HTTPException(status_code=400, detail="invalid status")
    with open(DATA_FILE) as f:
        data = json.load(f)
    updated = 0
    for fips, c in data["counties"].items():
        if c.get("state", "").upper() == state:
            c["status"]          = status
            c["description"]     = description
            c["_admin_override"] = True
            updated += 1
    with open(DATA_FILE, "w") as f:
        json.dump(data, f)
    return {"ok": True, "updated": updated}

import time as _time
_START_TIME = str(int(_time.time()))  # changes every container restart / deploy

@app.get("/api/version")
def version():
    return {"version": _START_TIME}

@app.get("/test")
def test_page():
    html = """<!DOCTYPE html><html><head><title>Map Diagnostics</title></head><body>
<h2>Map Load Diagnostics</h2>
<div id='log' style='font-family:monospace;font-size:14px'></div>
<script>
const log = (msg, ok=true) => {
  const el = document.createElement('div');
  el.style.color = ok ? 'green' : 'red';
  el.textContent = (ok ? '✅ ' : '❌ ') + msg;
  document.getElementById('log').appendChild(el);
};
async function run(){
  log('Starting tests...', true);
  try {
    const r1 = await fetch('/d3.min.js');
    log(`d3.min.js: HTTP ${r1.status}, ${r1.headers.get('content-type')}, ${(await r1.arrayBuffer()).byteLength} bytes`);
  } catch(e){ log('d3.min.js FAILED: '+e.message, false); }
  try {
    const r2 = await fetch('/topojson-client.min.js');
    log(`topojson.min.js: HTTP ${r2.status}, ${(await r2.arrayBuffer()).byteLength} bytes`);
  } catch(e){ log('topojson FAILED: '+e.message, false); }
  try {
    const r3 = await fetch('/counties-10m.json');
    log(`counties-10m.json: HTTP ${r3.status}, ${(await r3.arrayBuffer()).byteLength} bytes`);
  } catch(e){ log('counties-10m.json FAILED: '+e.message, false); }
  try {
    const r4 = await fetch('/county-data.json');
    log(`county-data.json: HTTP ${r4.status}, ${(await r4.arrayBuffer()).byteLength} bytes`);
  } catch(e){ log('county-data.json FAILED: '+e.message, false); }
  log('All tests complete.');
}
run();
</script></body></html>"""
    return Response(content=html, media_type="text/html")

