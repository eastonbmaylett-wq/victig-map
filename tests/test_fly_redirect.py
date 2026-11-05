import http.client
from http.server import ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import threading
import unittest
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location(
    "fly_redirect", Path(__file__).resolve().parents[1] / "fly-redirect/server.py")
redirect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(redirect)


class FlyRedirectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), redirect.RedirectHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        try:
            connection.request(method, path, body)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_existing_public_links_and_aliases_redirect(self):
        for old, new in [("/", "/"), ("/embed", "/embed"),
                         ("/embed.html", "/embed"), ("/admin/", "/admin"),
                         ("/analytics.html", "/analytics"),
                         ("/county-data.json", "/county-data.json"),
                         ("/static/map.js", "/static/map.js")]:
            with self.subTest(old=old):
                status, headers, _ = self.request("GET", old)
                self.assertEqual(status, 307)
                self.assertEqual(headers["Location"], redirect.DESTINATION + new)
                self.assertEqual(headers["Cache-Control"], "no-store")

    def test_redirect_never_forwards_query_credentials_or_changes_host(self):
        for path in ["/admin?password=private-test-secret",
                     "http://untrusted.example/admin?token=private-test-secret",
                     "//untrusted.example/admin?next=https://untrusted.example"]:
            status, headers, body = self.request("GET", path)
            self.assertEqual(status, 307)
            self.assertEqual(urlsplit(headers["Location"]).netloc, urlsplit(redirect.DESTINATION).netloc)
            self.assertEqual(urlsplit(headers["Location"]).query, "")
            self.assertNotIn("private-test-secret", str(headers) + str(body))

    def test_legacy_writes_are_not_replayed(self):
        for method in ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]:
            status, headers, body = self.request(method, "/admin/update-county", "private-test-secret")
            self.assertEqual(status, 410)
            self.assertNotIn("Location", headers)
            self.assertEqual(json.loads(body)["url"], redirect.DESTINATION)
            self.assertNotIn(b"private-test-secret", body)

    def test_health_and_head_requests(self):
        status, headers, body = self.request("GET", "/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["status"], "ok")
        self.assertNotIn("Location", headers)
        status, headers, body = self.request("HEAD", "/embed")
        self.assertEqual(status, 307)
        self.assertEqual(body, b"")


if __name__ == "__main__":
    unittest.main()
