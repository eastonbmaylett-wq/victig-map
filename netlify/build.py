"""Create an allowlisted public site and a private, self-contained Python runtime.

Netlify invokes the Node adapter. The adapter runs the existing FastAPI app
using a bundled Linux Python interpreter; no request is forwarded to Fly.
"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".netlify-runtime"
PUBLIC = ROOT / "dist"
APP = RUNTIME / "app"
PYTHON_TARGET = "cpython-3.13.12-linux-x86_64-gnu"


def run(*args):
    subprocess.run(args, check=True, cwd=ROOT)


def main():
    if PUBLIC.exists():
        shutil.rmtree(PUBLIC)
    PUBLIC.mkdir()
    if APP.exists():
        shutil.rmtree(APP)
    APP.mkdir(parents=True)
    public_files = [
        "index.html", "admin.html", "analytics.html", "embed.html",
        "d3.min.js", "topojson-client.min.js", "counties-10m.json",
        "victig-logo.png", "victig-logo-white.png",
    ]
    app_files = public_files + [
        "main.py", "process.py", "public_data.py", "refresh_guard.py",
        "closure_data.py", "jurisdiction.py", "simplemaps-base.json", "county-data.json", "site-config.json",
    ]
    for name in app_files:
        shutil.copy2(ROOT / name, APP / name)
    shutil.copytree(ROOT / "static", APP / "static")
    for name in public_files:
        shutil.copy2(ROOT / name, PUBLIC / name)
    shutil.copytree(ROOT / "static", PUBLIC / "static")
    shutil.copy2(ROOT / "netlify/bridge.py", APP / "bridge.py")

    # The public root contains only explicit assets. Database, report files,
    # Python source, credentials, and the state seed never enter the CDN root.
    for page in ["index.html", "admin.html", "analytics.html", "embed.html"]:
        path = PUBLIC / page
        text = path.read_text()
        text = text.replace("<head>", '<head>\n<script src="/static/netlify-client.js"></script>', 1)
        path.write_text(text)

    version = os.environ.get("COMMIT_REF") or subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip()
    digest = hashlib.sha256()
    for path in sorted(APP.rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(APP).as_posix().encode())
            digest.update(path.read_bytes())
    manifest = {"commit": version, "buildId": digest.hexdigest()[:20], "python": PYTHON_TARGET}
    (RUNTIME / "manifest.json").write_text(json.dumps(manifest))
    (PUBLIC / "404.html").write_text("<!doctype html><title>Not found</title><h1>Page not found</h1>")

    if os.environ.get("VICTIG_BUILD_SKIP_RUNTIME") != "1":
        uv = shutil.which("uv")
        if not uv:
            run(sys.executable, "-m", "pip", "install", "uv==0.10.9")
            uv = shutil.which("uv")
        if not uv:
            raise RuntimeError("uv installation did not provide an executable")
        run(uv, "python", "install", PYTHON_TARGET, "--install-dir", str(RUNTIME / "python"), "--no-bin")
        packages = RUNTIME / "packages"
        if packages.exists():
            shutil.rmtree(packages)
        run(uv, "pip", "install", "--python-platform", "x86_64-manylinux_2_28",
            "--python-version", "3.13", "--only-binary", ":all:",
            "--target", str(packages), "-r", str(ROOT / "netlify/requirements.txt"))
        # Distribution tests, bytecode, headers, and static archives are not needed at runtime.
        for parent in [RUNTIME / "python", packages]:
            for path in sorted(parent.rglob("__pycache__"), reverse=True):
                shutil.rmtree(path, ignore_errors=True)
            for path in list(parent.rglob("*.a")):
                path.unlink()
        python_root = RUNTIME / "python" / PYTHON_TARGET
        for name in ["include", "share", "lib/python3.13/test", "lib/python3.13/ensurepip"]:
            shutil.rmtree(python_root / name, ignore_errors=True)
    print(json.dumps({"publicFiles": len(list(PUBLIC.rglob("*"))), "build": manifest,
                      "runtimeBytes": sum(p.stat().st_size for p in RUNTIME.rglob("*") if p.is_file())}))


if __name__ == "__main__":
    main()
