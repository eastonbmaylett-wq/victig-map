import os
import json
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AutomationEndpointTests(unittest.TestCase):
    def test_auth_closure_refresh_and_failed_refresh_rollback(self):
        with tempfile.TemporaryDirectory() as temp_name:
            temp_dir = Path(temp_name)
            shutil.copy2(ROOT / "county-data.json", temp_dir / "county-data.json")
            shutil.copy2(ROOT / "site-config.json", temp_dir / "site-config.json")
            seed_path = temp_dir / "county-data.json"
            seed = json.loads(seed_path.read_text())
            if len(seed.get("stateAvg", {})) < 40:
                seed["stateAvg"] = {str(index): {} for index in range(40)}
                seed_path.write_text(json.dumps(seed))
            environment = os.environ.copy()
            environment["DATA_DIR"] = str(temp_dir)
            environment["VICTIG_MAP_INGEST_TOKEN"] = "test-ingestion-token"
            script = textwrap.dedent(
                """
                import hashlib
                from datetime import datetime, timezone
                from fastapi.testclient import TestClient
                import main

                client = TestClient(main.app)
                closure_text = (
                    "Report Turnaround Time Delays and Court Updates - "
                    + datetime.now(timezone.utc).strftime("%B %d, %Y") + "\\n"
                    "ALABAMA\\n"
                    "AUTAUGA COUNTY courthouse is closed due to storm damage.\\n"
                )
                denied = client.post(
                    "/automation/refresh",
                    files={"closures_file": ("closures.txt", closure_text, "text/plain")},
                )
                assert denied.status_code == 401, denied.text

                accepted = client.post(
                    "/automation/refresh",
                    headers={"Authorization": "Bearer test-ingestion-token"},
                    files={"closures_file": ("closures.txt", closure_text, "text/plain")},
                )
                assert accepted.status_code == 200, accepted.text
                payload = accepted.json()
                assert payload["ok"] is True
                assert payload["closures"]["skipped"] == 0
                assert payload["closures"]["closed"] == 1
                before_hash = hashlib.sha256(main.DATA_FILE.read_bytes()).hexdigest()

                rejected = client.post(
                    "/automation/refresh",
                    headers={"Authorization": "Bearer test-ingestion-token"},
                    files={"closures_file": ("closures.txt", "not a closure document", "text/plain")},
                )
                assert rejected.status_code == 400, rejected.text
                after_hash = hashlib.sha256(main.DATA_FILE.read_bytes()).hexdigest()
                assert before_hash == after_hash
                assert list((main.DATA_DIR / "backups").glob("county-data-*.json"))
                """
            )
            result = subprocess.run(
                [sys.executable, "-c", script],
                cwd=str(ROOT),
                env=environment,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)


if __name__ == "__main__":
    unittest.main()
