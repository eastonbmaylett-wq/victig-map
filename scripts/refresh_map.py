#!/usr/bin/env python3
"""Validate and publish a guarded TAT-map refresh."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import secrets
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from closure_data import (
    apply_closure_entries,
    desc_docx_text,
    extract_closure_source_date,
    html_to_desc_text,
    parse_desc_docx,
    parse_desc_html,
    parse_desc_text,
    validate_closure_source_date,
)
from refresh_guard import summarize_dataset, validate_freshness, validate_transition


DEFAULT_BASE_URL = "https://precious-dolphin-3f8f85.netlify.app"
KEYCHAIN_SERVICE = "victig-map-ingest"


def _json_from_url(url: str, *, timeout: int = 30) -> dict:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"GET {url} returned HTTP {response.status}")
        return json.load(response)


def _get_ingest_token() -> str:
    token = os.environ.get("VICTIG_MAP_INGEST_TOKEN", "").strip()
    if token:
        return token
    if sys.platform == "darwin":
        result = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    raise RuntimeError(
        "No ingestion token found in VICTIG_MAP_INGEST_TOKEN or the macOS Keychain"
    )


def _validate_file(path: Path, allowed_suffixes: set[str], maximum_bytes: int) -> None:
    if not path.is_file():
        raise ValueError(f"Input file does not exist: {path}")
    if path.suffix.lower() not in allowed_suffixes:
        allowed = ", ".join(sorted(allowed_suffixes))
        raise ValueError(f"Unsupported file type for {path.name}; expected {allowed}")
    if path.stat().st_size <= 0:
        raise ValueError(f"Input file is empty: {path.name}")
    if path.stat().st_size > maximum_bytes:
        raise ValueError(f"Input file exceeds its size limit: {path.name}")


def _local_candidate(
    before: dict,
    tat_report: Path | None,
    closures_docx: Path | None,
    max_age_days: int,
    max_closure_age_days: int,
) -> tuple[dict, dict | None]:
    closure_summary = None
    with tempfile.TemporaryDirectory(prefix="victig-map-refresh-") as temp_name:
        temp_dir = Path(temp_name)
        data_path = temp_dir / "county-data.json"
        data_path.write_text(json.dumps(before), encoding="utf-8")

        if tat_report is not None:
            environment = os.environ.copy()
            environment["DATA_DIR"] = str(temp_dir)
            result = subprocess.run(
                [sys.executable, str(ROOT / "process.py"), str(tat_report)],
                cwd=str(ROOT),
                env=environment,
                capture_output=True,
                text=True,
                timeout=180,
            )
            if result.returncode != 0:
                diagnostic = (result.stderr or result.stdout or "unknown error")[-800:]
                raise ValueError(f"Local TAT validation failed: {diagnostic}")

        candidate = json.loads(data_path.read_text(encoding="utf-8"))
        if closures_docx is not None:
            if closures_docx.suffix.lower() == ".docx":
                raw = closures_docx.read_bytes()
                closure_text = desc_docx_text(raw)
                entries = parse_desc_docx(raw)
            elif closures_docx.suffix.lower() in {".html", ".htm"}:
                raw_html = closures_docx.read_text(
                    encoding="utf-8-sig", errors="replace"
                )
                closure_text = html_to_desc_text(raw_html)
                entries = parse_desc_html(raw_html)
            else:
                closure_text = closures_docx.read_text(
                    encoding="utf-8-sig", errors="replace"
                )
                entries = parse_desc_text(closure_text)
            if not entries:
                raise ValueError("Closure document produced no usable entries")
            closure_source_date = extract_closure_source_date(closure_text)
            validate_closure_source_date(
                closure_source_date,
                previous_date=before.get("closureSourceDate"),
                max_age_days=max_closure_age_days,
            )
            closure_summary = apply_closure_entries(candidate, entries)
            candidate["closureSourceDate"] = closure_source_date.isoformat()

        validate_transition(before, candidate)
        if tat_report is not None:
            validate_freshness(candidate, max_age_days=max_age_days)
        return candidate, closure_summary


def _multipart_body(files: dict[str, Path]) -> tuple[bytes, str]:
    boundary = f"----victig-map-{secrets.token_hex(16)}"
    chunks: list[bytes] = []
    for field_name, path in files.items():
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                (
                    f'Content-Disposition: form-data; name="{field_name}"; '
                    f'filename="{path.name}"\r\n'
                ).encode(),
                f"Content-Type: {mime_type}\r\n\r\n".encode(),
                path.read_bytes(),
                b"\r\n",
            ]
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _publish(base_url: str, token: str, files: dict[str, Path]) -> dict:
    body, content_type = _multipart_body(files)
    version = _json_from_url(f"{base_url.rstrip('/')}/api/version")
    if version.get("hosting") == "netlify" and len(body) > 3 * 1024 * 1024:
        return _publish_chunked(base_url, token, body, content_type)
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/automation/refresh",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": content_type,
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=240) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read(4096).decode("utf-8", errors="replace")
        raise RuntimeError(f"Refresh rejected with HTTP {error.code}: {detail}") from error
    if not payload.get("ok"):
        raise RuntimeError("Refresh endpoint did not confirm success")
    return payload


def _publish_chunked(base_url: str, token: str, body: bytes, content_type: str) -> dict:
    """Stage authenticated, bounded chunks and verify the full multipart digest."""
    def send(route, data, method="POST", mime="application/json"):
        request = urllib.request.Request(
            f"{base_url.rstrip('/')}{route}", data=data, method=method,
            headers={"Authorization": f"Bearer {token}", "Content-Type": mime},
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read(2048).decode("utf-8", errors="replace")
            raise RuntimeError(f"Upload rejected with HTTP {error.code}: {detail}") from error

    upload = send("/api/uploads", json.dumps({
        "target": "/automation/refresh", "contentType": content_type,
        "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(),
    }).encode())
    size = upload["chunkBytes"]
    for index in range(upload["chunks"]):
        send(f"/api/uploads/{upload['id']}/{index}", body[index * size:(index + 1) * size],
             method="PUT", mime="application/octet-stream")
    result = send(f"/api/uploads/{upload['id']}/complete", b"")
    if not result.get("ok"):
        raise RuntimeError("Refresh endpoint did not confirm success")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tat-report", type=Path)
    parser.add_argument("--closures-docx", "--closures-file", dest="closures_docx", type=Path)
    parser.add_argument("--require-closures", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-age-days", type=int, default=3)
    parser.add_argument("--max-closure-age-days", type=int, default=14)
    parser.add_argument(
        "--base-url",
        default=os.environ.get("VICTIG_MAP_BASE_URL", DEFAULT_BASE_URL),
    )
    args = parser.parse_args()

    if args.tat_report is None and args.closures_docx is None:
        parser.error("provide --tat-report and/or --closures-docx")
    if args.require_closures and args.closures_docx is None:
        parser.error("--require-closures requires --closures-docx")
    if args.max_age_days < 0:
        parser.error("--max-age-days must be non-negative")
    if args.max_closure_age_days < 0:
        parser.error("--max-closure-age-days must be non-negative")

    if args.tat_report is not None:
        _validate_file(args.tat_report, {".xlsx", ".xlsm", ".csv"}, 100 * 1024 * 1024)
    if args.closures_docx is not None:
        _validate_file(
            args.closures_docx,
            {".docx", ".html", ".htm", ".txt"},
            25 * 1024 * 1024,
        )

    base_url = args.base_url.rstrip("/")
    before = _json_from_url(f"{base_url}/county-data.json")
    candidate, closure_summary = _local_candidate(
        before,
        args.tat_report,
        args.closures_docx,
        args.max_age_days,
        args.max_closure_age_days,
    )
    local_summary = summarize_dataset(candidate)
    if args.dry_run:
        print(
            json.dumps(
                {
                    "ok": True,
                    "dryRun": True,
                    "candidate": local_summary,
                    "closures": closure_summary,
                },
                sort_keys=True,
            )
        )
        return 0

    files = {}
    if args.tat_report is not None:
        files["tat_file"] = args.tat_report
    if args.closures_docx is not None:
        files["closures_file"] = args.closures_docx
    response = _publish(base_url, _get_ingest_token(), files)

    live = _json_from_url(f"{base_url}/county-data.json")
    live_summary = summarize_dataset(live)
    if live_summary != local_summary:
        raise RuntimeError("Live readback does not match the validated candidate summary")
    if live != candidate:
        raise RuntimeError("Live readback does not match the complete validated candidate")
    if live_summary["privateFieldCount"]:
        raise RuntimeError("Live readback contains private report fields")

    print(
        json.dumps(
            {
                "ok": True,
                "dryRun": False,
                "backup": response.get("backup"),
                "live": live_summary,
                "closures": response.get("closures"),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
