from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
import subprocess, shutil, os, hashlib, json
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
    "X-Frame-Options":           "DENY",
    "X-XSS-Protection":          "1; mode=block",
    "Referrer-Policy":           "no-referrer",
    "Permissions-Policy":        "geolocation=(), camera=(), microphone=()",
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
    if suffix in BLOCKED_EXTENSIONS and path not in ("county-data.json",):
        return JSONResponse(status_code=404, content={"detail": "Not found"})
    response = await call_next(request)
    for k, v in SECURITY_HEADERS.items():
        response.headers[k] = v
    return response

# ── Public routes ─────────────────────────────────────────────────────────
@app.get("/")
def root():
    return FileResponse(BASE / "index.html", media_type="text/html")

@app.get("/county-data.json")
def get_data():
    """Serve only the sanitized county stats — no PII."""
    return FileResponse(
        DATA_FILE,
        media_type="application/json",
        headers={"Cache-Control": "no-cache"}
    )

# ── Admin routes (password required for all writes) ───────────────────────
@app.get("/admin")
def admin_page():
    return FileResponse(BASE / "admin.html", media_type="text/html")

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
    if not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="CSV files only")
    # Save to a temp path outside the web root
    tmp = Path("/tmp/victig_upload.csv")
    with open(tmp, "wb") as f:
        shutil.copyfileobj(file.file, f)
    result = subprocess.run(
        ["python3", str(BASE / "process.py"), str(tmp)],
        capture_output=True, text=True, cwd=str(BASE)
    )
    tmp.unlink(missing_ok=True)  # delete immediately after processing
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=result.stderr[:500])
    return {"ok": True, "message": "Map data updated successfully"}

@app.get("/api/version")
def version():
    return {"version": "1.0.0"}

# ── Catch-all 404 ─────────────────────────────────────────────────────────
@app.get("/{path:path}")
def catch_all(path: str):
    return JSONResponse(status_code=404, content={"detail": "Not found"})
