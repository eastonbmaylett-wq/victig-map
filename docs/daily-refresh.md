# Daily TAT and court-notice refresh

Production: https://precious-dolphin-3f8f85.netlify.app

The guarded runner validates a local candidate, publishes to the existing
Netlify project, and checks the public readback. Authentication uses the
Netlify runtime variable `VICTIG_MAP_INGEST_TOKEN`. Its local copy is in macOS
Keychain service `victig-map-ingest`. Never include the token in a command,
log, report, or Git commit.

```sh
python3 scripts/refresh_map.py --tat-report /private/path/report.csv --dry-run
python3 scripts/refresh_map.py --tat-report /private/path/report.csv
```

Add `--closures-file /private/path/bulletin.html --require-closures` when
importing a new authoritative court bulletin. A TAT-only run preserves saved
notices and manual overrides. Closure imports require the bulletin's embedded
date, prevent date regression, and reject sources older than 14 days.

## Taz report

Use **Turnaround Time by Search**, report 441:
https://victig.instascreen.net/is/app/utilities/reportDesigner/customReports/441/export

Select All Clients and a rolling six-month period ending today. The report
contains completed County Criminal and State Criminal searches and filters by
completion date. Do not substitute the Occupational Health daily-status CSV.
The November 5 export was successfully downloaded through the authenticated
browser; large reports can finish several minutes after the popup opens.
A short browser download timeout does not prove the report failed.

Validate the actual downloaded CSV: header, all rows, finite nonnegative TAT,
completion-date range, latest completion, row count below the configured cap,
and source hash. Remove Client Name, Candidate Name, and File # before upload.
Keep Search Name, Jurisdiction, Start Date/Time, Completion Date/Time, and
Search TAT. Preserve the raw export privately for audit evidence.

## Court notices

The authoritative bulletin comes from `emailupdates@victig.com` to the
connected work Gmail account, with a subject beginning **Report Turnaround
Time Delays and Court Updates**. Read its HTML body; the plain-text MIME part
can contain only a template. On November 5 the newest matching bulletin was
October 30. Existing saved notices were preserved during the TAT-only refresh.
Do not infer new closures or remove saved human changes from missing data.

## Publication checks

- The importer must account for every source jurisdiction. Inspect unmatched
  output and resolve identity before publishing; do not invent county data.
- Confirm the county inventory, all county boundaries and popups, source date,
  populated counties, statewide counts, and absence of private fields.
- Compare saved notices and overrides with the current production snapshot.
- Large requests use authenticated 2 MB chunks with a full SHA-256 check.
  Conditional Netlify Blob writes reject concurrent changes and preserve a
  backup of the previous state. Failed processing cannot publish partial data.
- Compare complete live JSON with the validated candidate after publication.

The legacy browser collector is not an unattended download implementation.
No daily schedule is established by these instructions. Fly remains available
until authorized Hub and Taz editors replace their external Fly links.
