import unittest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient
from local_admin import server


class LocalAdminTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app, base_url='http://127.0.0.1:8766')

    def test_local_pages_and_public_embed_target(self):
        page = self.client.get('/admin')
        self.assertEqual(page.status_code, 200)
        self.assertIn('window.VICTIG_PUBLIC_MAP_ORIGIN', page.text)
        self.assertIn(server.PUBLIC, page.text)
        self.assertIn('/local-client.js', page.text)

    def test_unauthorized_writes_never_load_live_state(self):
        with patch.object(server, 'snapshot', new_callable=AsyncMock) as snapshot:
            response = self.client.post('/admin/update-state', json={'state': 'UT', 'password': 'wrong'})
        self.assertEqual(response.status_code, 401)
        snapshot.assert_not_awaited()

    def test_cross_origin_write_is_rejected(self):
        result = self.client.post('/admin/upload', headers={'Origin': 'https://untrusted.example'})
        self.assertEqual(result.status_code, 403)

    def test_nonlocal_host_is_rejected(self):
        result = self.client.get('/admin', headers={'Host': 'external.example'})
        self.assertEqual(result.status_code, 400)

    def test_source_and_runtime_files_are_not_served(self):
        for path in ['/main.py', '/local_admin/store.mjs', '/analytics.db', '/.git/config']:
            self.assertEqual(self.client.get(path).status_code, 404, path)

    def test_preview_does_not_add_public_analytics(self):
        response = self.client.post('/api/log/click', json={'fips': '49001'})
        self.assertEqual(response.json(), {'ok': True, 'localPreview': True})


if __name__ == '__main__':
    unittest.main()
