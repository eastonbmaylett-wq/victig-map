import unittest
from datetime import date

from refresh_guard import validate_freshness, validate_transition


def dataset(max_date="2026-08-11", private=False):
    counties = {}
    for index in range(3000):
        latest = {"tat": 1.0} if index < 600 else None
        if private and index == 0:
            latest["candidate"] = "private"
        counties[str(index).zfill(5)] = {
            "latest": latest,
            "description": "",
            "status": "ok",
        }
    return {
        "maxDate": max_date,
        "stateAvg": {str(index): {} for index in range(40)},
        "counties": counties,
    }


class RefreshGuardTests(unittest.TestCase):
    def test_valid_transition_passes(self):
        before = dataset("2026-08-10")
        after = dataset("2026-08-11")
        _, summary = validate_transition(before, after)
        self.assertEqual(summary["countyCount"], 3000)

    def test_private_field_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "private"):
            validate_transition(dataset(), dataset(private=True))

    def test_regressive_date_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "regressed"):
            validate_transition(dataset("2026-08-11"), dataset("2026-08-10"))

    def test_stale_data_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "older"):
            validate_freshness(
                dataset("2026-08-01"), max_age_days=3, today=date(2026, 8, 11)
            )


if __name__ == "__main__":
    unittest.main()
