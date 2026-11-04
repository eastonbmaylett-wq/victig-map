import json
import tempfile
import unittest
from pathlib import Path

from public_data import (
    scrub_public_json_file,
    strip_private_fields,
    write_public_json_atomic,
)


def sample_data():
    return {
        "maxDate": "2026-08-12",
        "counties": {
            "49035": {
                "latest": {
                    "tat": 1.25,
                    "search": "County Criminal Records Search",
                    "client": "Private Client",
                    "candidate": "Private Person",
                    "file_num": "123456",
                },
                "outliers": [
                    {
                        "tat": 15,
                        "reason": "Court delay",
                        "search": "County Criminal Records Search",
                        "client": "Private Client",
                    }
                ],
            },
            "49049": {"latest": None, "outliers": None},
        },
    }


class PublicDataTests(unittest.TestCase):
    def test_strip_private_fields_preserves_public_stats(self):
        data = sample_data()
        removed = strip_private_fields(data)

        self.assertEqual(removed, 4)
        latest = data["counties"]["49035"]["latest"]
        self.assertEqual(latest["tat"], 1.25)
        self.assertEqual(latest["search"], "County Criminal Records Search")
        self.assertNotIn("client", latest)
        self.assertNotIn("candidate", latest)
        self.assertNotIn("file_num", latest)
        self.assertNotIn("client", data["counties"]["49035"]["outliers"][0])

    def test_atomic_writer_never_persists_private_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "county-data.json"
            removed = write_public_json_atomic(path, sample_data())
            saved = json.loads(path.read_text())

            self.assertEqual(removed, 4)
            self.assertNotIn("candidate", saved["counties"]["49035"]["latest"])
            self.assertFalse(list(path.parent.glob(".county-data.json.tmp-*")))

    def test_existing_file_scrub_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "county-data.json"
            path.write_text(json.dumps(sample_data()))

            self.assertEqual(scrub_public_json_file(path), 4)
            self.assertEqual(scrub_public_json_file(path), 0)


if __name__ == "__main__":
    unittest.main()
