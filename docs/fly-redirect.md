# Temporary Fly redirect for existing map links

Status: prepared; deployment must be verified before treating the redirect as live.

The Hub WordPress page stores an iframe pointing to
`https://victig-map.fly.dev/embed`. Taz links to that Hub page. GitHub commits
update the application repository; they do not edit WordPress page content.
The Netlify repository connection deploys the updated map to
`https://precious-dolphin-3f8f85.netlify.app`.

`fly-redirect/server.py` is a small service for the existing Fly app. It sends
GET/HEAD requests to the corresponding Netlify address with HTTP 307 and
`Cache-Control: no-store`. Existing map, embed, admin, and analytics page
aliases are supported. Query strings are dropped to avoid forwarding legacy
URL credentials, and request targets are not logged. Health checks use
`/healthz` and return HTTP 200.

Legacy POST/PUT/PATCH/DELETE/OPTIONS requests return HTTP 410 with the new
address. They are not forwarded or applied to the old map. The existing
refresh runner already targets Netlify. The redirect service never reads or
changes the mounted data volume. Keep that volume and the original image
available until the migration and recovery window are complete.

## Verification and deployment

1. Back up the current map and site configuration. Create a coherent SQLite
   analytics backup, record its hash, and save the current image/configuration.
2. Run `python3 -m unittest discover -s tests -v`.
3. Use an authorized Fly session to build the image from
   `fly-redirect/Dockerfile`. Do not continue through an account restriction.
4. Deploy to the existing `victig-map` app and machine; do not create another
   app, move organizations, delete volumes, or add another production machine.
5. Check `/healthz`, the 307 destination for `/` and `/embed`, and the existing
   public Hub page. Confirm the actual embedded map uses Netlify and the
   current data date. Follow the existing Taz map link and verify the same page.
6. Compare Netlify data and configuration with their validated pre-deploy
   snapshots. Recheck every county in the production map and embed.
7. Create the final coherent legacy analytics snapshot and import it through
   Netlify's existing idempotent migration endpoint. Verify the event counts.

For rollback, deploy the saved original image with the saved original Fly
configuration. Noncached redirects and an untouched data volume permit this
without reconstructing the old application or deleting new Netlify data.

The redirect keeps the old hostname working; Fly must remain available until
an authorized Hub editor changes the iframe source to Netlify. Once all old
URLs are removed, retirement of the Fly service can be reviewed separately.
