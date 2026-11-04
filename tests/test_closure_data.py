import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from datetime import date
from pathlib import Path

from closure_data import (
    apply_closure_entries,
    extract_closure_source_date,
    parse_desc_docx,
    parse_desc_html,
    validate_closure_source_date,
)


ROOT = Path(__file__).resolve().parents[1]


def dataset():
    return {
        "maxDate": "2026-08-11",
        "stateAvg": {"AL": {}, "AK": {}},
        "counties": {
            "01001": {
                "fips": "01001",
                "name": "Autauga",
                "state": "AL",
                "status": "closed",
                "description": "Old closure",
                "_desc_doc": True,
                "_desc_doc_previous_status": "ok",
                "_desc_doc_previous_description": "",
            },
            "01003": {
                "fips": "01003",
                "name": "Baldwin",
                "state": "AL",
                "status": "significant",
                "description": "Manual note",
                "_admin_override": True,
            },
            "02013": {
                "fips": "02013",
                "name": "Aleutians East",
                "state": "AK",
                "status": "ok",
                "description": "",
            },
        },
    }


def make_docx(paragraphs):
    namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = "".join(
        f'<w:p><w:r><w:t>{value}</w:t></w:r></w:p>' for value in paragraphs
    )
    xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{namespace}"><w:body>{body}</w:body></w:document>'
    )
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("word/document.xml", xml)
    return payload.getvalue()


class ClosureDataTests(unittest.TestCase):
    def test_parser_handles_current_html_email_shape_and_source_date(self):
        html = """
        <html><head><title>Report Turnaround Time Delays and Court Updates – August 7th, 2026</title></head>
        <body><div>CALIFORNIA</div>
        <p>LOS ANGELES:</p>
        <p>LOS ANGELES COUNTY clerks require hard copy verification.</p>
        <div>OHIO</div>
        <p>An outage is currently affecting the HIGHLAND MUNICIPAL COURT index.</p>
        <div>WEST VIRGINIA</div>
        <p>Cases in WEST VIRGINIA requiring clerk assistance are delayed.</p>
        <p>Kind Regards,</p><p>Team VICTIG</p></body></html>
        """
        entries = parse_desc_html(html)
        targets = {(state, county) for state, county, _ in entries}
        self.assertIn(("CA", "LOS ANGELES"), targets)
        self.assertIn(("OH", "HIGHLAND"), targets)
        self.assertIn(("WV", None), targets)
        self.assertEqual(extract_closure_source_date(html), date(2026, 8, 7))

    def test_closure_source_date_rejects_stale_and_regressive_bulletins(self):
        validate_closure_source_date(
            date(2026, 8, 7), today=date(2026, 8, 12), max_age_days=14
        )
        with self.assertRaisesRegex(ValueError, "older than"):
            validate_closure_source_date(
                date(2026, 7, 1), today=date(2026, 8, 12), max_age_days=14
            )
        with self.assertRaisesRegex(ValueError, "regressed"):
            validate_closure_source_date(
                date(2026, 8, 7),
                previous_date="2026-08-08",
                today=date(2026, 8, 12),
            )

    def test_parser_recognizes_specific_closure(self):
        entries = parse_desc_docx(
            make_docx(
                [
                    "ALABAMA",
                    "AUTAUGA COUNTY courthouse is closed due to storm damage.",
                ]
            )
        )
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0][0:2], ("AL", "AUTAUGA"))

    def test_parser_handles_real_document_sentence_patterns(self):
        entries = parse_desc_docx(
            make_docx(
                [
                    "PENNSYLVANIA",
                    "Staffing shortages among MONTGOMERY COUNTY court clerks are causing delays.",
                    "ARKANSAS",
                    "Staffing shortages among HOWARD, MISSISSIPPI and YELL COUNTY court clerks are causing delays.",
                    "TEXAS",
                    "An outage affects several Texas counties. Expect order delays in ARANSAS, HUDSPETH and WHARTON",
                    "WASHINGTON",
                    "MOTOR VEHICLE REPORTS (MVR) will be unavailable during maintenance.",
                ]
            )
        )
        targets = {(state, county) for state, county, _ in entries}
        self.assertEqual(
            targets,
            {
                ("PA", "MONTGOMERY"),
                ("AR", "HOWARD"),
                ("AR", "MISSISSIPPI"),
                ("AR", "YELL"),
                ("TX", "ARANSAS"),
                ("TX", "HUDSPETH"),
                ("TX", "WHARTON"),
            },
        )

    def test_new_document_replaces_old_closures_and_preserves_manual_override(self):
        data = dataset()
        result = apply_closure_entries(
            data,
            [
                ("AK", "ALEUTIANS EAST", "The courthouse is closed due to flooding."),
                ("AL", None, "State systems are delayed while maintenance is completed."),
            ],
        )

        autauga = data["counties"]["01001"]
        baldwin = data["counties"]["01003"]
        alaska = data["counties"]["02013"]
        self.assertEqual(autauga["status"], "delay")
        self.assertIn("maintenance", autauga["description"])
        self.assertEqual(baldwin["status"], "significant")
        self.assertEqual(baldwin["description"], "Manual note")
        self.assertEqual(alaska["status"], "closed")
        self.assertEqual(result["manualPreserved"], 1)

    def test_removed_document_closure_reverts_to_prior_values(self):
        data = dataset()
        apply_closure_entries(
            data,
            [("AK", "ALEUTIANS EAST", "The courthouse is closed due to flooding.")],
        )
        autauga = data["counties"]["01001"]
        self.assertEqual(autauga["status"], "ok")
        self.assertEqual(autauga["description"], "")
        self.assertNotIn("_desc_doc", autauga)

    def test_tat_processor_preserves_document_and_stat_overrides(self):
        with tempfile.TemporaryDirectory() as temp_name:
            temp_dir = Path(temp_name)
            existing = dataset()
            existing["counties"]["01003"]["_overrides"] = {"max": "14d"}
            (temp_dir / "county-data.json").write_text(json.dumps(existing))
            report = temp_dir / "tat.csv"
            report.write_text(
                "Jurisdiction,Search TAT,Start Date/Time,Search Name\n"
                "AL-Autauga County,1.5,2026-08-11 12:00:00,County Criminal Search\n"
            )
            environment = os.environ.copy()
            environment["DATA_DIR"] = str(temp_dir)
            result = subprocess.run(
                [sys.executable, str(ROOT / "process.py"), str(report)],
                cwd=str(ROOT),
                env=environment,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            refreshed = json.loads((temp_dir / "county-data.json").read_text())

        self.assertTrue(refreshed["counties"]["01001"]["_desc_doc"])
        self.assertEqual(refreshed["counties"]["01001"]["status"], "closed")
        self.assertEqual(
            refreshed["counties"]["01003"]["_overrides"], {"max": "14d"}
        )


if __name__ == "__main__":
    unittest.main()
