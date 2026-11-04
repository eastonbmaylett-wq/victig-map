#!/usr/bin/env python3
"""Repair the CT inventory in a persisted dataset before the next report import.

Dry-run by default. Only empty planning-region records may be removed. No TAT
values are assigned to counties: the next report import supplies those values.
"""

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile


ROOT = Path(__file__).resolve().parents[1]
COUNTIES = {
    "09001": "Fairfield", "09003": "Hartford", "09005": "Litchfield",
    "09007": "Middlesex", "09009": "New Haven", "09011": "New London",
    "09013": "Tolland", "09015": "Windham",
}
REGIONS = {str(value) for value in range(9110, 9200, 10)}
REGIONS = {value.zfill(5) for value in REGIONS}
FIELDS = {
    "fips", "name", "state", "status", "description", "periods", "types",
    "trend", "latest", "precomp", "outliers", "state_avg",
}


def repair(data, topology):
    geometry = {
        str(g["id"]).zfill(5): g["properties"]["name"]
        for g in topology["objects"]["counties"]["geometries"]
        if str(g["id"]).zfill(5).startswith("09")
    }
    if geometry != COUNTIES:
        raise ValueError("Connecticut boundaries differ from the expected eight counties")
    result = deepcopy(data)
    counties = result["counties"]
    unexpected = {k for k in counties if k.startswith("09")} - REGIONS - COUNTIES.keys()
    if unexpected:
        raise ValueError("Unexpected Connecticut identifiers; review required")
    for fips in REGIONS & counties.keys():
        county = counties[fips]
        populated = any(county.get(k) for k in (
            "description", "periods", "types", "trend", "latest", "precomp", "outliers"
        ))
        if (populated or set(county) - FIELDS or county.get("status", "ok") != "ok"
                or county.get("state") != "CT" or county.get("fips") != fips):
            raise ValueError(f"Refusing to discard data or overrides for {fips}")
        del counties[fips]
    for fips, name in COUNTIES.items():
        if fips in counties:
            if counties[fips].get("name") != name or counties[fips].get("state") != "CT":
                raise ValueError(f"County identity conflict for {fips}")
            continue
        counties[fips] = {
            "fips": fips, "name": name, "state": "CT", "status": "ok",
            "description": "", "periods": None, "types": None, "trend": 0,
            "latest": None, "precomp": None, "outliers": None,
            "state_avg": deepcopy(data.get("stateAvg", {}).get("CT")),
        }
    return result


def apply(path, topology, expected_sha256):
    before_bytes = path.read_bytes()
    digest = hashlib.sha256(before_bytes).hexdigest()
    if digest != expected_sha256:
        raise ValueError("Dataset changed since review; refusing to overwrite it")
    before = json.loads(before_bytes)
    after = repair(before, topology)
    if before == after:
        return {"changed": False, "sha256": digest}
    backups = path.parent / "backups"
    backups.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = backups / f"county-data-before-ct-repair-{stamp}-{digest[:12]}.json"
    with backup.open("xb") as handle:
        handle.write(before_bytes)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(backup, 0o600)
    fd, temporary = tempfile.mkstemp(prefix=".ct-repair-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(after, handle)
            handle.flush()
            os.fsync(handle.fileno())
        if path.read_bytes() != before_bytes:
            raise ValueError("Dataset changed during repair; refusing to overwrite it")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    if json.loads(path.read_bytes()) != after:
        raise RuntimeError("Repair readback did not match")
    return {"changed": True, "backup": str(backup),
            "countyCount": len(after["counties"]),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--topology", type=Path, default=ROOT / "counties-10m.json")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-sha256")
    args = parser.parse_args()
    topology = json.loads(args.topology.read_bytes())
    if args.apply:
        if not args.expected_sha256:
            parser.error("--apply requires --expected-sha256 from a reviewed dry-run")
        print(json.dumps(apply(args.dataset, topology, args.expected_sha256)))
    else:
        raw = args.dataset.read_bytes()
        before = json.loads(raw)
        after = repair(before, topology)
        print(json.dumps({
            "dryRun": True, "sha256": hashlib.sha256(raw).hexdigest(),
            "beforeCount": len(before["counties"]),
            "afterCount": len(after["counties"]),
            "added": sorted(after["counties"].keys() - before["counties"].keys()),
            "removed": sorted(before["counties"].keys() - after["counties"].keys()),
        }))


if __name__ == "__main__":
    main()
