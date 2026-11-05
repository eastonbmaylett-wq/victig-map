# County coverage and November 5 refresh

The map contains 3,232 county and county-equivalent records. Connecticut uses
its eight court counties, matching the Taz jurisdictions. Every record must
have exactly one nonempty clickable boundary and a searchable detail popup.
A county with no searches in the last 90 days remains available and appears
gray. The popup identifies the missing county data and separately labels any
statewide average. Missing data must never be presented as a zero-day TAT.

## County identity

`jurisdiction.py` resolves state/name pairs before aggregating rows. It keeps
independent cities separate from same-named counties, combines Saint/St. and
Sainte/Ste. variants, and normalizes accents and legal suffixes. Full state
names and statewide search jurisdictions contribute to statewide statistics,
not county statistics. Unmatched jurisdictions are reported by `process.py`.
Do not silently assign an unknown jurisdiction to a neighboring county.

The reported TAT, existing rolling-period rules, saved court notices, and
manual overrides remain intact. County ranks now contain county records only.
The dataset records the accepted report row count and latest completion time.

## Boundaries

The retired Alaska Valdez-Cordova boundary (02261) was replaced with Chugach
(02063) and Copper River (02066). All other original county geometries and arcs
were retained. The replacement source is the Census Bureau ACS 2025 generalized
county layer, queried for these two GEOIDs in longitude/latitude coordinates:

https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2025/State_County/MapServer/12

Source GeoJSON SHA-256:
`d381723da2e2fab7c08c8e9f12413177f3501bcf43f5014b7e0bfa694f33105c`

The source rings were quantized to the existing TopoJSON transform and wound
for D3 spherical rendering. Puerto Rico, the U.S. Virgin Islands, Guam,
American Samoa, and the Northern Mariana Islands use separate inset
projections. Search opens their details without zooming the mainland map.

## Refresh source

Taz report 441, **Turnaround Time by Search**, All Clients, May 5 through
November 5, 2026, completed County Criminal and State Criminal searches,
filtered by completion date. The export contains 207,496 rows, with latest
completion at November 5, 2026 10:47:31 as reported by Taz.

Only Search Name, Jurisdiction, Start Date/Time, Completion Date/Time, and
Search TAT are passed to the refresh. Client names, candidate names, and file
numbers are excluded. Raw exports and credentials do not belong in Git.

Sanitized CSV SHA-256:
`1e8305771502c3d0e10322dbe6fe4c7f1effce3edc658a431994492a99da2c1b`

All 207,496 rows resolve to a county or statewide jurisdiction. The candidate
contains 2,496 populated county records, averages for 55 states/territories,
and all 718 previously saved document notices. No saved status, description,
or manual override changed.

## Verification

Run the Python suite, build the runtime, and run the Netlify adapter suite
with `VICTIG_TEST_REPORT` pointing to the sanitized export. Verify the live
public and embed pages by opening every county popup, checking each displayed
value against the dataset, and confirming all boundaries are nonempty.
Automated click checks suppress analytics only for the duration of the test.
Compare the complete live JSON to the locally validated candidate after the
production refresh; a count-only comparison is not sufficient.
