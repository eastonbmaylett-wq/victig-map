# Netlify migration

Target project: `precious-dolphin-3f8f85`.
Site ID: `aa3c8c95-afc1-4d66-a96d-98827dac978d`.

This branch starts from GitHub main and includes a November 4 snapshot of the
current Fly application. The snapshot preserves the newer production interface,
data validation, privacy filters, and court-notice processing that GitHub lacked.
The Connecticut correction and validated November 4 TAT dataset are included.

## Runtime and storage

- Netlify serves only the public files explicitly copied into `dist/`.
- The `map` Node function invokes the existing Python FastAPI application using
  a bundled Linux Python 3.13.12 interpreter. No route proxies to Fly.
- Each invocation has a separate temporary data directory that is removed
  after the request. County identity corrections are documented in
  `county-verification.md`.
- Netlify Blobs stores the map, configuration, and analytics. Strong reads and
  conditional writes prevent overwriting a concurrent change.
- Production uses `victig-map-v1-production`. Every preview has a separate store
  named for its deployment ID. A preview cannot change production data.
- Every map update first saves the previous state as a backup. Daily cleanup
  retains the newest 14 backups and removes expired upload staging data.
- The existing admin password remains valid. Browser upload and analytics
  requests send it in a header instead of a URL query parameter.
- The existing ingestion token must be copied to the Netlify runtime variable
  `VICTIG_MAP_INGEST_TOKEN`. Do not commit credentials or raw Taz reports.

## Uploads and analytics

Browser TAT imports and column previews use protocol 2: raw file slices of 2 MiB,
each with a SHA-256 checksum. Completion records a SHA-256 of the ordered chunk
hashes, queues the report, and returns immediately. The browser invokes
`process-upload-background` with only the upload ID and authentication header,
then polls the authenticated status endpoint. Credentials are never saved in
upload metadata. A worker lease prevents duplicate processing, and publication
uses the existing operation ID, backup, and conditional state replacement.

The background worker verifies every chunk and writes one temporary report on
disk. Python inherits that file descriptor without base64, multipart copies,
or Excel-to-CSV expansion. The processor makes two streaming passes and retains
statistics per jurisdiction rather than every report row. Column previews read
only six rows. CSV, TSV, XLSX, and XLSM retain the admin's sheet selection and
existing county, period, ranking, notice, and privacy behavior.

The browser's report limit is **400 MiB**, with a **14-minute** worker budget
(including downloading chunks), leaving time for cleanup inside Netlify's
15-minute background-function limit. These are resource bounds, not a promise
of unlimited files: complex Excel workbooks can still exhaust available memory.
Background functions are available on credit-based Free plans; no plan upgrade
or additional developer seat is needed. See
[Netlify background functions](https://docs.netlify.com/build/functions/background-functions/)
and [function limits](https://docs.netlify.com/build/functions/configuration/).

The map stays unchanged until processing succeeds and the conditional save
accepts the current revision. Failed validation or processing does not publish.
An interrupted connection can leave a successful background publication; reload
the map to check its current data before retrying. An import replaces report
statistics; uploading arbitrary file pieces separately does not merge them.
Larger-than-400-MiB reports need a separately reviewed local processing route.

Staging expires after 30 minutes (renewed when queued). Finished workers remove
raw chunks immediately, including failed validation; daily cleanup handles
abandoned uploads. Completed responses are replayable until expiry. The legacy
multipart protocol used by the guarded Python refresh runner and description
imports remains compatible, with its 48-second synchronous processing budget
and existing 100 MB automated TAT / 25 MB automated closure file limits.
Legacy location enrichment runs in batches of ten records, with the browser
continuing through the remaining batches. Each batch fits the function limit.

`POST /api/migration/analytics` accepts the legacy SQLite snapshot with the
ingestion bearer token. It checks database integrity and imports historical rows
by their original Fly event IDs. Repeating an import does not duplicate events,
and visits already recorded on Netlify remain intact. Analytics stays private.

## Verification

For the large-report regression checks, run:

```sh
npm run build
python3 -m unittest discover -s tests -p 'test_*.py'
VICTIG_STRESS_TEST=1 VICTIG_SLOW_BACKGROUND_TEST=1 npm run test:netlify
```

The opt-in stress check stages and processes a synthetic CSV just under 400 MiB,
verifies all 417,759 rows, and removes its files. The slow-worker check spends
49 seconds in a fixture processor to verify it can finish past the old timeout.
Use only synthetic reports in preview storage. Verify the deploy includes both
`map` and `process-upload-background` before a production cutover.

```sh
npm ci
npm run build
python3 -m unittest discover -s tests -v
npm run test:netlify
netlify build --offline
```

Set `VICTIG_TEST_REPORT` to the validated local, sanitized report to compare the
adapter's complete output against direct Python processing. This test does not
send the report or change a live application.

## Deployment and cutover

1. Deploy a private Netlify preview and verify its Python runtime, storage,
   authentication, large upload, analytics, and all eight Connecticut clicks.
2. Recheck the live Fly dataset for changes since the source snapshot. Reconcile
   any new manual changes before publishing the Netlify seed.
3. Set the ingestion token through Netlify's protected environment settings.
4. Import a fresh, consistent Fly analytics snapshot and verify its row count.
5. Deploy the reviewed commit to the existing Netlify project. Verify public,
   embed, and admin pages against the same persisted state.
6. Replace existing external Fly URLs with the Netlify URL before stopping Fly.
   The `fly.dev` hostname belongs to Fly and cannot be transferred to Netlify.

Automatic Fly deployment is disabled in this branch. The manual recovery
workflow and original Fly volume remain available during cutover. Production
deployment rollback does not roll back Blob data; restore a selected data backup
with a freshly verified current revision when a data rollback is required.

## Remaining improvements

- Move from the legacy shared admin password to individual authenticated users.
  Password rotation and account changes are separate from this migration.
