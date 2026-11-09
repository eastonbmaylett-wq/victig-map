"""Keep existing Fly/Hub links working after the map moves to Netlify.

This service never opens the old data volume or accepts map writes. Public
navigation uses temporary, noncached redirects so an image rollback is enough
to restore the previous app. Query strings are intentionally not forwarded.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from urllib.parse import urlsplit

DESTINATION = "https://precious-dolphin-3f8f85.netlify.app"
ALIASES = {
    "/index.html": "/",
    "/embed.html": "/embed",
    "/admin.html": "/admin",
    "/analytics.html": "/analytics",
}


class RedirectHandler(BaseHTTPRequestHandler):
    server_version = "VictigMapRedirect/1"
    sys_version = ""

    def log_message(self, format, *args):
        # Old URLs can contain credentials. Do not log request targets.
        pass

    def reply(self, status, payload=None, location=None):
        body = json.dumps(payload).encode() if payload is not None else b""
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if location:
            self.send_header("Location", location)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        try:
            path = "/" + urlsplit(self.path).path.lstrip("/")
        except ValueError:
            self.reply(400, {"error": "Invalid request path"})
            return
        if path == "/healthz":
            self.reply(200, {"status": "ok", "destination": DESTINATION})
            return
        if path.rstrip("/") in {"/embed", "/admin", "/analytics"}:
            path = path.rstrip("/")
        self.reply(307, location=DESTINATION + ALIASES.get(path, path))

    do_HEAD = do_GET

    def moved(self):
        # Do not replay a legacy write or forward its credentials to another host.
        self.reply(410, {"error": "The map has moved. Use the Netlify address.",
                         "url": DESTINATION})

    do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = moved


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), RedirectHandler).serve_forever()
