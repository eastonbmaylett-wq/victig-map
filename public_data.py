"""Helpers for keeping the public county dataset free of private report fields."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


PRIVATE_LATEST_FIELDS = ("client", "candidate", "file_num")
PRIVATE_OUTLIER_FIELDS = ("client",)


def strip_private_fields(data: dict[str, Any]) -> int:
    """Remove report-only private fields in place and return the number removed."""
    removed = 0
    counties = data.get("counties")
    if not isinstance(counties, dict):
        return removed

    for county in counties.values():
        if not isinstance(county, dict):
            continue

        latest = county.get("latest")
        if isinstance(latest, dict):
            for field in PRIVATE_LATEST_FIELDS:
                if field in latest:
                    del latest[field]
                    removed += 1

        outliers = county.get("outliers")
        if isinstance(outliers, list):
            for outlier in outliers:
                if not isinstance(outlier, dict):
                    continue
                for field in PRIVATE_OUTLIER_FIELDS:
                    if field in outlier:
                        del outlier[field]
                        removed += 1

    return removed


def write_public_json_atomic(path: str | Path, data: dict[str, Any]) -> int:
    """Strip private fields and atomically replace the public JSON file."""
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    removed = strip_private_fields(data)
    temporary = destination.with_name(f".{destination.name}.tmp-{os.getpid()}")

    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(data, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)

    return removed


def write_bytes_atomic(path: str | Path, payload: bytes) -> None:
    """Atomically replace a file with already-validated bytes."""
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp-{os.getpid()}")

    try:
        with temporary.open("wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def scrub_public_json_file(path: str | Path) -> int:
    """Sanitize an existing public JSON file, rewriting it only when needed."""
    source = Path(path)
    if not source.exists():
        return 0

    with source.open(encoding="utf-8") as handle:
        data = json.load(handle)

    removed = strip_private_fields(data)
    if removed:
        write_public_json_atomic(source, data)
    return removed
