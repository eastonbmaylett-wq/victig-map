# Daily TAT and Court-Closure Refresh

## Deployed foundation

The production map accepts an authenticated multipart refresh at
`POST /automation/refresh`.

- Authentication: `Authorization: Bearer ...` using the Fly secret
  `VICTIG_MAP_INGEST_TOKEN`.
- The local copy of that token is stored in macOS Keychain under the service
  `victig-map-ingest`; it is not the admin password.
- TAT inputs: `.xlsx`, `.xlsm`, or `.csv`.
- Closure inputs: `.docx`, `.html`, `.htm`, or UTF-8 `.txt` from the
  authoritative client-update bulletin. The embedded bulletin date is required,
  may not regress, and must be no more than 14 days old.
- Either file may be supplied alone. A TAT-only run preserves the last approved
  document-managed closure entries.
- A refresh is serialized, backed up on the Fly volume, written atomically, and
  restored automatically if parsing or validation fails. The latest 14 backups
  are retained under `/data/backups`.

The server rejects a TAT candidate when it changes the county inventory,
contains fewer than 40 states or 500 populated counties, loses more than 40%
of populated counties, regresses `maxDate`, is older than three days, or
contains any private `client`, `candidate`, or `file_num` field.

## Local guarded runner

Dry-run a report and closure document without changing production:

```bash
python3 scripts/refresh_map.py \
  --tat-report /path/to/turnaround.xlsx \
  --closures-file /path/to/court-updates.docx \
  --require-closures \
  --dry-run
```

Publish the same validated inputs and verify the live readback:

```bash
python3 scripts/refresh_map.py \
  --tat-report /path/to/turnaround.xlsx \
  --closures-file /path/to/court-updates.docx \
  --require-closures
```

The runner retrieves the ingestion token from Keychain, performs a complete
local candidate build first, publishes only after validation passes, and then
requires the public endpoint summary to match the local candidate.

## Source status as of 2026-08-12

### TAT report

Taz exposes the report at the legacy route:

`/turnaroundexport/turnaroundExportForm.taz`

The required daily export is a rolling six-month **Turnaround Time by Search**
report for completed County Criminal and State Criminal Court searches, using
the search-completion date. The existing Occupational Health daily-status
exporter does not implement this report.

`scripts/taz_turnaround_collector.mjs` now owns the dedicated-profile,
same-invocation authentication and read-only form-discovery boundary. It
supports protected Chrome autofill, the exact Taz Keychain fallback, no-echo
stdin MFA, authenticated `Order / Workspace / Workload` proof, and outputs
only form metadata. On 2026-08-12 the dedicated profile had no usable saved
autofill and the newly provisioned `EastonM` Keychain credential was rejected
by Taz as `Login Failed`. Do not retry until the current credential/account is
confirmed. The live form and download response therefore remain unproven.

### Court closures and delays

The authoritative bulletin is delivered to the connected `eastonm@victig.com`
Gmail account from `emailupdates@victig.com` with a subject beginning
`Report Turnaround Time Delays and Court Updates`. The newest message found on
2026-08-12 is dated August 7, 2026. The HTML body contains the current and
ongoing state/county notices; the plain-text MIME part is only a template and
must not be used. Closure ingestion now accepts that HTML body directly and
records its date in the public dataset as `closureSourceDate`.

## Remaining work before unattended scheduling

1. Confirm the current Taz credential/account, then live-prove the existing
   Turnaround collector against the form and download response.
2. Fetch the newest matching Gmail bulletin, require the expected sender and
   subject, and save its HTML MIME body for the guarded runner.
3. Run one combined dry-run and compare TAT/closure deltas with the current map.
4. Run one approved live canary and verify `maxDate`, `closureSourceDate`,
   county/state counts,
   closure counts, private-field count, and public map rendering.
5. Create the daily schedule only after the canary passes. The scheduler must
   fail privately when Taz authentication/MFA, source freshness, validation,
   upload, or live readback fails.
6. Separately rotate and redesign the legacy shared admin password. The
   automation path does not use it, but the manual admin UI still sends it in
   query parameters and uses a public client-side hash.
