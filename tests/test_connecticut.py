from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("repair_connecticut", ROOT / "scripts/repair_connecticut.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
TOPOLOGY = json.loads((ROOT / "counties-10m.json").read_text())


def fixture():
    counties = {
        fips: {"fips": fips, "name": "Planning region", "state": "CT",
               "status": "ok", "description": "", "periods": None}
        for fips in module.REGIONS
    }
    counties["01001"] = {"name": "Autauga", "state": "AL", "status": "delay",
                         "description": "Keep this note", "_admin_override": True}
    return {"maxDate": "2026-11-03", "stateAvg": {"CT": {"avg": 2.2}}, "counties": counties}


class ConnecticutTests(unittest.TestCase):
    def test_base_matches_every_connecticut_boundary(self):
        base = json.loads((ROOT / "simplemaps-base.json").read_text())
        ct = {k: v["name"] for k, v in base.items() if k.startswith("09")}
        self.assertEqual(ct, module.COUNTIES)

    def test_repair_preserves_unrelated_data_and_does_not_invent_county_stats(self):
        before = fixture()
        saved = deepcopy(before)
        after = module.repair(before, TOPOLOGY)
        self.assertEqual(before, saved)
        self.assertEqual(after["counties"]["01001"], before["counties"]["01001"])
        self.assertEqual(after["stateAvg"], before["stateAvg"])
        self.assertEqual(after["maxDate"], before["maxDate"])
        self.assertEqual({k for k in after["counties"] if k.startswith("09")}, set(module.COUNTIES))
        for fips in module.COUNTIES:
            self.assertIsNone(after["counties"][fips]["periods"])
            self.assertEqual(after["counties"][fips]["state_avg"], before["stateAvg"]["CT"])

    def test_repair_is_idempotent_and_preserves_county_overrides(self):
        after = module.repair(fixture(), TOPOLOGY)
        after["counties"]["09001"].update(_admin_override=True, description="Manual note")
        self.assertEqual(module.repair(after, TOPOLOGY), after)

    def test_repair_refuses_to_discard_region_data_or_override(self):
        for changes in [{"description": "Note"}, {"_admin_override": True},
                        {"status": "closed"}, {"periods": {"90d": {"avg": 1}}}]:
            with self.subTest(changes=changes):
                data = fixture()
                data["counties"]["09110"].update(changes)
                with self.assertRaisesRegex(ValueError, "Refusing to discard"):
                    module.repair(data, TOPOLOGY)

    def test_repair_checks_boundary_identity(self):
        topology = deepcopy(TOPOLOGY)
        for geometry in topology["objects"]["counties"]["geometries"]:
            if geometry["id"] == "09001":
                geometry["properties"]["name"] = "Wrong county"
        with self.assertRaisesRegex(ValueError, "boundaries differ"):
            module.repair(fixture(), topology)

    def test_apply_requires_reviewed_hash_and_keeps_exact_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "county-data.json"
            raw = json.dumps(fixture()).encode()
            path.write_bytes(raw)
            with self.assertRaisesRegex(ValueError, "changed since review"):
                module.apply(path, TOPOLOGY, "wrong")
            self.assertEqual(path.read_bytes(), raw)
            result = module.apply(path, TOPOLOGY, hashlib.sha256(raw).hexdigest())
            self.assertEqual(Path(result["backup"]).read_bytes(), raw)
            self.assertEqual(json.loads(path.read_bytes()), module.repair(json.loads(raw), TOPOLOGY))
            second = module.apply(path, TOPOLOGY, result["sha256"])
            self.assertFalse(second["changed"])

    def test_report_import_matches_all_eight_counties(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            report = temp / "report.csv"
            report.write_text(
                "Jurisdiction,Search TAT,Start Date/Time,Search Name\n" +
                "".join(f"CT-{name} County,{i},2026-11-03 09:00:00,County Criminal Records Search\n"
                        for i, name in enumerate(module.COUNTIES.values(), 1))
            )
            environment = dict(os.environ, DATA_DIR=str(temp))
            completed = subprocess.run([sys.executable, str(ROOT / "process.py"), str(report)],
                                       env=environment, capture_output=True, text=True)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            data = json.loads((temp / "county-data.json").read_text())
            for i, (fips, name) in enumerate(module.COUNTIES.items(), 1):
                self.assertEqual(data["counties"][fips]["name"], name)
                self.assertEqual(data["counties"][fips]["periods"]["90d"]["avg"], i)
            self.assertFalse(module.REGIONS & data["counties"].keys())


if __name__ == "__main__":
    unittest.main()
