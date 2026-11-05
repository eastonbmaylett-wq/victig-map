# Mac mini admin with the existing public map

Open http://127.0.0.1:8766/admin on the Mac mini. Use the existing map admin password.
The shortcut is `~/Applications/VICTIG Map Admin.webloc`.

The admin page and report processing run on the Mac. Saves publish sanitized
county data and configuration to the existing Netlify state store. The Hub
iframe, public map address, public analytics, and GitHub deployment connection
remain unchanged. No raw report is uploaded to Netlify by the Mac service.

Each operation starts from the current live state. Processing uses a private
temporary directory. Validation rejects incomplete reports, changed county
inventories, private report fields, and stale TAT imports. Publication uses the
same conditional state write and backup routine as the existing Netlify app.
A concurrent change is rejected instead of being overwritten. The admin reports
success only after the public JSON matches the complete locally processed result.
An identical upload performs readback verification without rewriting live state.

The local admin displays a publication status banner. If the connection fails
after a save, publication may already have completed; reload before retrying.
Raw files and request credentials are removed with the temporary directory.
Before/after public data and result receipts remain in private local backups.

The service listens on `127.0.0.1:8766` only. It starts after this user logs in
and restarts if the process exits. It does not open router ports, create a tunnel,
change DNS, or grant remote access. The public map stays available when the Mac
is off. Internet access is required to load current data and publish updates.

## Install or restart

Requires Node 22+, Python 3.13, and the user's existing Netlify CLI sign-in.
The server reads the existing Netlify CLI credential locally; it is never sent
to the browser or written into the launch agent.

```sh
npm ci --ignore-scripts
uv venv --python python3.13 "$HOME/Library/Application Support/VICTIG TAT Map/venv"
uv pip install --python "$HOME/Library/Application Support/VICTIG TAT Map/venv/bin/python" -r local_admin/requirements.txt
python3 local_admin/install.py
```

The launch agent is `~/Library/LaunchAgents/com.victig.tat-map-admin.plist`.
Data, backups, and logs are under `~/Library/Application Support/VICTIG TAT Map`.
Access logging is disabled so request passwords cannot appear in URL logs.
The local UI moves query-string passwords into request headers.

Stop the local service with `python3 local_admin/install.py --stop`.
The public map is unaffected. For a permanent uninstall, remove the launch-agent
plist after stopping it; preserve the private data directory if backups are needed.

The public admin remains available as the existing fallback. Retirement of that
admin or all Netlify hosting is outside this first local-admin cutover.

## Verification

`node --test tests/local-publish.test.mjs` verifies backups, conditional writes,
operation retention, unchanged uploads, private-field rejection, and readback failure.
`python -m unittest discover -s tests -p test_local_admin.py` verifies local-only
access, authentication, allowed files, public embed links, and preview analytics.
Use the latest sanitized Taz report for an actual local upload and compare the
complete public dataset before and after. Never put credentials or raw reports in Git.

Local backups currently have no automatic expiry. A retention policy can be added
after the required recovery period is agreed.

The publisher uses Netlify's documented personal-access-token and conditional-write
support: https://docs.netlify.com/build/data-and-storage/netlify-blobs/.
