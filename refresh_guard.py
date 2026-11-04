"""Validation gates for automated TAT map refreshes."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from public_data import PRIVATE_LATEST_FIELDS, PRIVATE_OUTLIER_FIELDS


def summarize_dataset(data: dict[str, Any]) -> dict[str, Any]:
    counties = data.get("counties")
    if not isinstance(counties, dict):
        counties = {}
    values = [county for county in counties.values() if isinstance(county, dict)]
    state_avg = data.get("stateAvg")
    if not isinstance(state_avg, dict):
        state_avg = {}

    private_fields = 0
    for county in values:
        latest = county.get("latest")
        if isinstance(latest, dict):
            private_fields += sum(field in latest for field in PRIVATE_LATEST_FIELDS)
        outliers = county.get("outliers")
        if isinstance(outliers, list):
            for outlier in outliers:
                if isinstance(outlier, dict):
                    private_fields += sum(
                        field in outlier for field in PRIVATE_OUTLIER_FIELDS
                    )

    return {
        "maxDate": data.get("maxDate"),
        "closureSourceDate": data.get("closureSourceDate"),
        "countyCount": len(values),
        "statesWithData": len(state_avg),
        "latestCount": sum(isinstance(county.get("latest"), dict) for county in values),
        "descriptionCount": sum(bool(county.get("description")) for county in values),
        "closedCount": sum(county.get("status") == "closed" for county in values),
        "documentManagedCount": sum(bool(county.get("_desc_doc")) for county in values),
        "privateFieldCount": private_fields,
    }


def _parse_date(value: Any) -> date:
    if not isinstance(value, str):
        raise ValueError("dataset maxDate is missing")
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as error:
        raise ValueError("dataset maxDate must use YYYY-MM-DD") from error


def validate_freshness(
    data: dict[str, Any],
    *,
    max_age_days: int = 3,
    today: date | None = None,
) -> None:
    max_date = _parse_date(data.get("maxDate"))
    current_date = today or datetime.now(timezone.utc).date()
    if max_date > current_date + timedelta(days=1):
        raise ValueError("dataset maxDate is unexpectedly in the future")
    if max_date < current_date - timedelta(days=max_age_days):
        raise ValueError(
            f"dataset maxDate is older than the allowed {max_age_days}-day window"
        )


def validate_transition(
    before: dict[str, Any],
    after: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Reject incomplete, regressive, or private refresh output."""
    before_summary = summarize_dataset(before)
    after_summary = summarize_dataset(after)

    if after_summary["countyCount"] < 3000:
        raise ValueError("refresh output contains fewer than 3,000 counties")
    if (
        before_summary["countyCount"]
        and after_summary["countyCount"] != before_summary["countyCount"]
    ):
        raise ValueError("refresh changed the county inventory")
    if after_summary["statesWithData"] < 40:
        raise ValueError("refresh output contains fewer than 40 states with data")
    if after_summary["latestCount"] < 500:
        raise ValueError("refresh output contains too few populated counties")
    if (
        before_summary["latestCount"]
        and after_summary["latestCount"] < before_summary["latestCount"] * 0.60
    ):
        raise ValueError("refresh output lost more than 40% of populated counties")
    if after_summary["privateFieldCount"]:
        raise ValueError("refresh output still contains private report fields")

    before_date = _parse_date(before_summary["maxDate"])
    after_date = _parse_date(after_summary["maxDate"])
    if after_date < before_date:
        raise ValueError("refresh maxDate regressed")

    return before_summary, after_summary
