import hashlib
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


class BackfillBatchTests(unittest.TestCase):
    def test_batches_advance_even_when_geolocation_has_no_result(self):
        script = textwrap.dedent('''
            import asyncio, hashlib
            import main
            main.PW_HASH = hashlib.sha256(b'test').hexdigest()
            main._geoip_sync = lambda ip: ''
            con = main._analytics_conn()
            con.executemany("INSERT INTO events(ts,ip,event) VALUES(?,?,?)",
                            [('2026-11-04T10:00:00', '127.0.0.1', 'visit')] * 23)
            con.commit(); con.close()
            async def run():
                cursor = 0
                sizes = []
                while True:
                    result = await main.backfill_geo('test', after_id=cursor)
                    sizes.append(result['total'])
                    assert result['enriched'] == 0
                    if not result['has_more']: break
                    assert result['next_after_id'] > cursor
                    cursor = result['next_after_id']
                assert sizes == [10, 10, 3], sizes
            asyncio.run(run())
        ''')
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, '-c', script],
                cwd=Path(__file__).resolve().parents[1],
                env={**os.environ, 'DATA_DIR': directory}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
