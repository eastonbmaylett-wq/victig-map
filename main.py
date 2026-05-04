from fastapi import FastAPI, UploadFile, File, HTTPException, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import subprocess, shutil, os, hashlib, json
from pathlib import Path

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

BASE = Path(__file__).parent
DATA_FILE = BASE / "county-data.json"

# Password hash (Victig2026!)
PW_HASH = "b3121997c76507dc7adcf3ca13ee60d519cbc3c72a176527e8ba575fc13f3406"

def check_auth(password: str):
    h = hashlib.sha256(password.encode()).hexdigest()
    if h != PW_HASH:
        raise HTTPException(status_code=401, detail="Invalid password")

@app.get("/")
def root():
    return FileResponse(BASE / "index.html")

@app.get("/county-data.json")
def get_data():
    return FileResponse(DATA_FILE)

@app.post("/admin/upload")
async def upload_csv(password: str, file: UploadFile = File(...)):
    check_auth(password)
    # Save uploaded CSV
    csv_path = BASE / "uploaded.csv"
    with open(csv_path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    # Run processing script
    result = subprocess.run(
        ["python3", str(BASE / "process.py"), str(csv_path)],
        capture_output=True, text=True, cwd=str(BASE)
    )
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=result.stderr)
    return {"ok": True, "message": "Map data updated successfully"}

@app.get("/api/version")
def version():
    return {"version": "1.0.0"}

# Serve other static files (JS etc if needed)
