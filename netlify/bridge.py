"""Invoke the production FastAPI app once, with invocation-local files.

Input/output use files so neither request bodies nor credentials enter logs.
The Node adapter owns durable storage, optimistic concurrency, and rollback.
"""
import asyncio
import base64
import contextlib
import io
import json
import os
import hashlib
import sqlite3
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode


async def invoke(payload):
    # Suppress startup diagnostics from the response channel. Errors remain private.
    with contextlib.redirect_stdout(io.StringIO()):
        import main
    from starlette.requests import Request
    from public_data import strip_private_fields

    # The same existing password remains valid. It travels in a header on
    # Netlify, while the unchanged FastAPI route receives it internally.
    headers = [(str(k).lower(), str(v)) for k, v in payload.get("headers", [])]
    header_map = dict(headers)
    if payload["path"] == "/internal/upload-self-test":
        # Fixed synthetic inputs only. runPython gives this check its own data
        # directory and never publishes any of its outputs to durable storage.
        import tempfile
        import openpyxl
        rows = [["Jurisdiction", "Search TAT", "Start Date/Time"],
                ["CT-Fairfield County", 2, "2026-11-09 10:00:00"],
                ["CT-Fairfield County", 4, "2026-11-08 10:00:00"]]
        for extension in ("csv", "xlsx"):
            with tempfile.TemporaryFile() as source:
                if extension == "csv":
                    source.write(('\n'.join(','.join(map(str, row)) for row in rows) + '\n').encode())
                else:
                    workbook = openpyxl.Workbook()
                    workbook.active.title = "Turnaround Report"
                    for row in rows:
                        workbook.active.append(row)
                    workbook.save(source)
                    workbook.close()
                source.flush()
                main._process_admin_report(source, f"synthetic.{extension}")
                data = json.loads(main.DATA_FILE.read_text())
                if data.get("reportRowCount") != 2 or data["counties"]["09001"]["periods"]["90d"]["avg"] != 3:
                    raise RuntimeError("Synthetic report readback failed")
        return {"status": 200, "headers": [["content-type", "application/json"]],
                "body": base64.b64encode(b'{"ok":true,"csv":true,"xlsx":true}').decode()}
    if payload.get("report"):
        # Background imports use an already verified file on disk. Do not turn
        # it into base64, multipart bytes, or another in-memory copy.
        from fastapi import HTTPException, UploadFile
        report = payload["report"]
        routes = {"/admin/upload": main.upload_csv,
                  "/admin/preview-columns": main.preview_columns}
        if payload["path"] not in routes:
            raise ValueError("Invalid report route")
        with open(report["path"], "rb") as handle:
            upload = UploadFile(file=handle, filename=report["filename"])
            response_headers = [["content-type", "application/json"]]
            try:
                document = await routes[payload["path"]](
                    password=header_map.get("x-victig-password", ""), file=upload)
                status = 200
            except HTTPException as error:
                document, status = {"detail": error.detail}, error.status_code
                response_headers.extend((error.headers or {}).items())
        if main.DATA_FILE.exists():
            data = json.loads(main.DATA_FILE.read_text())
            if strip_private_fields(data):
                main.DATA_FILE.write_text(json.dumps(data))
        return {"status": status, "headers": response_headers,
                "body": base64.b64encode(json.dumps(document, default=str).encode()).decode()}
    query = dict(parse_qsl(payload.get("query", ""), keep_blank_values=True))
    if header_map.get("x-victig-password"):
        query["password"] = header_map["x-victig-password"]
    body = base64.b64decode(payload.get("body", ""))
    if header_map.get("x-victig-password") and header_map.get("content-type", "").startswith("application/json"):
        document = json.loads(body or b"{}")
        if isinstance(document, dict):
            document["password"] = header_map["x-victig-password"]
            body = json.dumps(document).encode()
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1", "method": payload["method"],
        "scheme": "https", "path": payload["path"],
        "raw_path": payload["path"].encode(), "query_string": urlencode(query).encode(),
        "root_path": "", "headers": [(k.encode(), v.encode()) for k, v in headers],
        "client": (payload.get("ip", "127.0.0.1"), 0), "server": ("netlify", 443),
    }
    consumed = False
    finished = asyncio.Event()
    chunks = []
    result = {"status": 500, "headers": []}

    async def receive():
        nonlocal consumed
        if not consumed:
            consumed = True
            return {"type": "http.request", "body": body, "more_body": False}
        await finished.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.start":
            result["status"] = message["status"]
            result["headers"] = [(k.decode(), v.decode()) for k, v in message["headers"]]
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))
            if not message.get("more_body", False):
                finished.set()

    if payload["path"] == "/api/log/visit":
        request = Request(scope, receive)
        event = json.loads(body or b"{}").get("event", "visit")
        if event not in {"visit", "embed"}:
            raise ValueError("Invalid visit event")
        row_id = main._log_event(request, event)
        if row_id and payload.get("location"):
            con = main._analytics_conn()
            con.execute("UPDATE events SET state=? WHERE id=?", (payload["location"], row_id))
            con.commit()
            con.close()
        return {"status": 200, "headers": [["content-type", "application/json"]],
                "body": base64.b64encode(b'{"ok":true}').decode()}

    if payload["path"] == "/api/migration/analytics":
        legacy_file = main.DATA_DIR / "legacy-analytics.db"
        legacy_file.write_bytes(body)
        legacy = sqlite3.connect(f"file:{legacy_file}?mode=ro", uri=True)
        if legacy.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Legacy analytics database failed its integrity check")
        rows = legacy.execute("SELECT id,ts,ip,ua,event,county_id,county,state FROM events ORDER BY id").fetchall()
        legacy.close()
        con = main._analytics_conn()
        con.execute("CREATE TABLE IF NOT EXISTS fly_migration_rows (legacy_id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL)")
        inserted = 0
        with con:
            for legacy_id, *values in rows:
                prior = con.execute("SELECT event_id FROM fly_migration_rows WHERE legacy_id=?", (legacy_id,)).fetchone()
                if prior:
                    con.execute("UPDATE events SET ts=?,ip=?,ua=?,event=?,county_id=?,county=?,state=? WHERE id=?", (*values, prior[0]))
                else:
                    cursor = con.execute("INSERT INTO events(ts,ip,ua,event,county_id,county,state) VALUES (?,?,?,?,?,?,?)", values)
                    con.execute("INSERT INTO fly_migration_rows(legacy_id,event_id) VALUES (?,?)", (legacy_id, cursor.lastrowid))
                    inserted += 1
        total = con.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        con.close()
        result = {"ok": True, "sourceRows": len(rows), "inserted": inserted,
                  "totalRows": total, "sha256": hashlib.sha256(body).hexdigest()}
        return {"status": 200, "headers": [["content-type", "application/json"]],
                "body": base64.b64encode(json.dumps(result).encode()).decode()}

    await main.app(scope, receive, send)
    if main.DATA_FILE.exists():
        data = json.loads(main.DATA_FILE.read_text())
        if strip_private_fields(data):
            main.DATA_FILE.write_text(json.dumps(data))
    result["body"] = base64.b64encode(b"".join(chunks)).decode()
    return result


if __name__ == "__main__":
    source, destination = map(Path, sys.argv[1:3])
    payload = json.loads(source.read_text())
    response = asyncio.run(invoke(payload))
    destination.write_text(json.dumps(response))
