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

Netlify has a 6 MB buffered request limit. The browser and guarded Python
refresh runner stage large uploads as authenticated 2 MB chunks. The server
requires every chunk and verifies the complete SHA-256 digest before processing.
Completed uploads have an idempotent response. Staging expires after 30 minutes;
successful uploads delete their chunks immediately. Daily cleanup handles
abandoned uploads.

Function processing stops after 48 seconds. A timeout or failed validation
does not publish any map changes. Test the largest normal report in a preview
before cutover. The existing 100 MB TAT and 25 MB closure file limits remain.
Legacy location enrichment runs in batches of ten records, with the browser
continuing through the remaining batches. Each batch fits the function limit.

`POST /api/migration/analytics` accepts the legacy SQLite snapshot with the
ingestion bearer token. It checks database integrity and imports historical rows
by their original Fly event IDs. Repeating an import does not duplicate events,
and visits already recorded on Netlify remain intact. Analytics stays private.

## Verification

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
