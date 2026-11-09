#!/usr/bin/env python3
"""
Victig TAT Map — Data Processor (v2)
Supports:
  - Old CSV format: Jurisdiction, Search TAT, Start Date/Time, Search Name
  - New Excel format: Jurisdiction, Exact TAT, Start Date/Time, Completion Date/Time,
                      Unique Jurisdiction, Avg. TAT, Max. TAT, Min. TAT, >2 weeks TAT, <0.007 TAT
Usage: python3 process.py <path-to-csv-or-xlsx>
"""
import argparse, csv, json, io, re, sys, os
from datetime import datetime
from collections import defaultdict
from functools import lru_cache
from itertools import chain
from pathlib import Path
from public_data import write_public_json_atomic
from jurisdiction import JurisdictionResolver

BASE     = Path(__file__).parent
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
parser = argparse.ArgumentParser()
parser.add_argument('report', nargs='?', default=str(BASE / 'uploaded.csv'))
parser.add_argument('--format')
parser.add_argument('--input-fd', type=int)
parser.add_argument('--admin-upload', action='store_true')
args = parser.parse_args()
if args.input_fd is not None and (args.input_fd < 0 or not args.format):
    parser.error('--input-fd requires a nonnegative descriptor and --format')
IN_PATH = args.report
IN_FILE  = Path(IN_PATH)

STATE_FIPS = {
    '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT',
    '10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL',
    '18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD',
    '25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE',
    '32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND',
    '39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD',
    '47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV',
    '55':'WI','56':'WY'
}
COLOR_STATUS = {'#dea922':'delay','#de7612':'high_tat','#cf4027':'significant'}

# ── Helpers ───────────────────────────────────────────────────────────────
def classify(s):
    s = s.lower()
    if 'county' in s and 'criminal' in s: return 'county_criminal'
    if 'state' in s and ('criminal' in s or 'court' in s or 'search' in s): return 'statewide'
    return 'other'

class Stats:
    """Constant-memory summary, independent of the number of report rows."""
    def __init__(self):
        self.count = 0
        self.total = self.correction = 0.0
        self.minimum = float('inf')
        self.maximum = float('-inf')

    def add(self, value):
        total = self.total + value
        self.correction += ((self.total - total) + value if abs(self.total) >= abs(value)
                            else (value - total) + self.total)
        self.total = total
        self.count += 1
        self.minimum = min(self.minimum, value)
        self.maximum = max(self.maximum, value)

    def average(self):
        return (self.total + self.correction) / self.count

def compute_stats(vals):
    if not vals.count: return None
    return {'avg': round(vals.average(), 6), 'max': round(vals.maximum, 6),
            'min': round(vals.minimum, 6), 'count': vals.count}

@lru_cache(maxsize=8192)
def parse_dt(s):
    if not s: return None
    for fmt in ('%Y-%m-%d %H:%M:%S', '%m/%d/%Y %H:%M', '%Y-%m-%dT%H:%M:%S',
                '%m/%d/%Y %H:%M:%S', '%Y-%m-%d %H:%M'):
        try: return datetime.strptime(str(s).strip(), fmt)
        except: pass
    return None

def safe_float(v):
    try: return float(v)
    except: return None

# ── Read rows without retaining the report in memory ──────────────────────
suffix = (args.format or IN_FILE.suffix).lower()

def open_report():
    # Lambda does not provide /dev/fd. Duplicate the inherited descriptor
    # directly so each pass can close its stream without closing the original.
    if args.input_fd is not None:
        return os.fdopen(os.dup(args.input_fd), 'rb')
    return IN_FILE.open('rb')

def raw_rows():
    # Reopen for each pass: first find the report's max date, then aggregate.
    with open_report() as source:
        source.seek(0)
        if suffix in ('.xlsx', '.xlsm'):
            import openpyxl
            wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
            try:
                sheet = None
                for name in wb.sheetnames:
                    n = name.lower()
                    match = ('turnaround' in n or ('search' in n and 'tat' not in n)
                             or ('tat' in n and 'fastest' not in n and 'outlier' not in n)) if args.admin_upload else (
                                 'turnaround' in n or 'search' in n or 'tat' in n)
                    if match:
                        sheet = wb[name]
                        break
                if sheet is None:
                    sheet = max(wb.worksheets, key=lambda s: s.max_row or 0) if args.admin_upload else wb.active
                for row in sheet.iter_rows(values_only=True):
                    yield ['' if value is None else str(value) for value in row]
            finally:
                wb.close()
        else:
            text = io.TextIOWrapper(source, newline='', encoding='utf-8-sig')
            # Preserve the legacy preamble detection without readlines().
            for line in text:
                if 'jurisdiction' in line.lower() or 'search tat' in line.lower():
                    lines = chain([line], text)
                    break
            else:
                text.seek(0)
                lines = text
            yield from csv.reader(lines, delimiter='\t' if suffix in ('.tsv', '.txt') else ',')

source_rows = raw_rows()
header = next(source_rows, None)
source_rows.close()
if header is None:
    print("ERROR: No rows found in file"); sys.exit(1)

# ── Detect columns ────────────────────────────────────────────────────────
hmap   = {h.strip().lower(): i for i, h in enumerate(header)}

def col(name): return hmap.get(name.lower())

# Required columns (try both old + new names)
COL_JUR      = col('jurisdiction')
COL_EXACT    = col('exact tat')
COL_SEARCH   = col('search tat')
COL_TAT      = COL_EXACT if COL_EXACT is not None else COL_SEARCH   # prefer exact
COL_START    = col('start date/time')
COL_COMPLETE = col('completion date/time')
COL_SNAME    = col('search name')

# New pre-computed aggregate columns
COL_UJUR     = col('unique jurisdiction')
COL_AVG      = col('avg. tat')
COL_MAX      = col('max. tat')
COL_MIN      = col('min. tat')
COL_GT2W     = col('>2 weeks tat')
COL_LT007    = col('<0.007 tat')

is_new_format = COL_EXACT is not None

# Allow raw format: no TAT column but start + completion present → compute on the fly
COMPUTE_TAT = COL_TAT is None and COL_START is not None and COL_COMPLETE is not None

if COL_JUR is None:
    print(f"ERROR: No 'Jurisdiction' column found. Header: {header}"); sys.exit(1)
if COL_TAT is None and not COMPUTE_TAT:
    print(f"ERROR: No TAT column found and no Start+Completion columns to compute from. Header: {header}"); sys.exit(1)

if COMPUTE_TAT:
    print("Format: RAW (TAT computed from Start/Completion dates)")
else:
    print(f"Format: {'NEW (Exact TAT)' if is_new_format else 'OLD (Search TAT)'}")
print(f"Columns: {len(header)} | Streaming report rows")

def data_rows():
    source = raw_rows()
    next(source, None)
    yield from source

def cell(row, index):
    return row[index].strip() if index is not None and index < len(row) else ''

def row_values(raw):
    dt = parse_dt(cell(raw, COL_START))
    if not cell(raw, COL_JUR) or dt is None:
        return None
    completed = parse_dt(cell(raw, COL_COMPLETE))
    if COMPUTE_TAT:
        tat = (completed - dt).total_seconds() / 86400 if completed and completed > dt else None
    else:
        tat = safe_float(cell(raw, COL_TAT))
    if tat is None or tat < 0:
        return None
    return tat, dt, completed

max_date = None
for raw in data_rows():
    values = row_values(raw)
    if values and (max_date is None or values[1] > max_date):
        max_date = values[1]
if max_date is None:
    print("ERROR: No valid data rows parsed"); sys.exit(1)

# ── Load SimpleMaps base (names, existing status/descriptions) ───────────
sm_file = BASE / "simplemaps-base.json"
with open(sm_file) as f:
    map_data = json.load(f)

county_db = {}
for fips, info in map_data.items():
    abbrev = STATE_FIPS.get(fips[:2], '')
    county_db[fips] = {
        'fips':        fips,
        'name':        info.get('name',''),
        'state':       abbrev,
        'status':      COLOR_STATUS.get(info.get('color',''), 'ok'),
        'description': info.get('description',''),
        'periods':  None,
        'types':    None,
        'trend':    0,
        'latest':   None,
        'precomp':  None,
        'outliers': None,
    }

# Add US territories from counties-10m.json
TERRITORY_FIPS = {'60':'AS','66':'GU','69':'MP','72':'PR','78':'VI'}
topo_file = BASE / "counties-10m.json"
if topo_file.exists():
    with open(topo_file) as f:
        topo_data = json.load(f)
    for geom in topo_data['objects']['counties']['geometries']:
        fips = str(geom['id'])
        if fips[:2] in TERRITORY_FIPS and fips not in county_db:
            name = geom.get('properties', {}).get('name', fips)
            county_db[fips] = {
                'fips': fips, 'name': name,
                'state': TERRITORY_FIPS[fips[:2]],
                'status': 'ok', 'description': '',
                'periods': None, 'types': None, 'trend': 0,
                'latest': None, 'precomp': None, 'outliers': None,
            }

resolver = JurisdictionResolver(county_db)
resolve_jurisdiction = lru_cache(maxsize=8192)(resolver.resolve)

# ── Parse rows ────────────────────────────────────────────────────────────
row_count, latest = 0, {}
unmatched = defaultdict(int)
completed_through = None
PERIODS = [('30d', 30), ('60d', 60), ('90d', 90), ('180d', 180)]
jur_periods = defaultdict(lambda: defaultdict(Stats))
jur_types = defaultdict(lambda: defaultdict(Stats))
jur_trend = defaultdict(lambda: {'recent': Stats(), 'prior': Stats()})
state_all_tats = defaultdict(Stats)
state_period_tats = defaultdict(lambda: defaultdict(Stats))
# Pre-computed jurisdiction stats from new format
precomp = {}  # jur -> {avg, max, min, gt2w, lt007}

for raw in data_rows():
    def get(c): return raw[c].strip() if c is not None and c < len(raw) else ''

    jur      = get(COL_JUR)
    date_str = get(COL_START)
    search   = get(COL_SNAME)
    raw_jur = jur
    canonical, jurisdiction_state = resolve_jurisdiction(jur, classify(search))
    jur = canonical or jur

    # Collect pre-computed stats (new format only)
    if COL_UJUR is not None:
        ujur = get(COL_UJUR)
        ujur = resolve_jurisdiction(ujur)[0] or ujur
        if ujur:
            avg = safe_float(get(COL_AVG))
            mx  = safe_float(get(COL_MAX))
            mn  = safe_float(get(COL_MIN))
            gt2 = safe_float(get(COL_GT2W))
            lt7 = safe_float(get(COL_LT007))
            if avg is not None:
                precomp[ujur] = {'avg': avg, 'max': mx, 'min': mn,
                                 'gt2weeks': int(gt2) if gt2 else 0,
                                 'lt10min':  int(lt7) if lt7 else 0}

    values = row_values(raw)
    if values is None: continue
    tat, dt, completed = values

    if canonical is None:
        unmatched[raw_jur] += 1
    if completed and (completed_through is None or completed > completed_through):
        completed_through = completed
    row_count += 1
    age = (max_date - dt).days
    if age <= 180:
        for label, days in PERIODS:
            if age <= days:
                jur_periods[jur][label].add(tat)
        jur_types[jur][classify(search)].add(tat)
    if age <= 60:
        jur_trend[jur]['recent' if age <= 30 else 'prior'].add(tat)
    if jurisdiction_state:
        state_all_tats[jurisdiction_state].add(tat)
        for label, days in PERIODS:
            if age <= days:
                state_period_tats[jurisdiction_state][label].add(tat)

    # Latest search per jurisdiction
    if jur not in latest or dt > latest[jur]['dt']:
        comp_str = get(COL_COMPLETE) if COL_COMPLETE else ''
        latest[jur] = {
            'dt': dt, 'tat': tat, 'search': search,
            'completion': comp_str,
        }

# ── Period stats (computed from individual rows) ──────────────────────────
period_stats = {}
for jur, pdata in jur_periods.items():
    period_stats[jur] = {p: compute_stats(v) for p,v in pdata.items()}

# Rank within each period
for period in ['30d','60d','90d','180d']:
    ranked = sorted(
        [(j, s[period]['avg']) for j,s in period_stats.items() if j in county_db and s.get(period)],
        key=lambda x: x[1]
    )
    for rank,(jur,_) in enumerate(ranked, 1):
        period_stats[jur][period]['rank']  = rank
        period_stats[jur][period]['total'] = len(ranked)

type_stats = {j:{t:compute_stats(v) for t,v in d.items()} for j,d in jur_types.items()}

trends = {}
for jur, d in jur_trend.items():
    if d['recent'].count and d['prior'].count:
        diff = d['prior'].average() - d['recent'].average()
        trends[jur] = 0 if abs(diff)<0.1 else (1 if diff>0 else -1)

latest_out = {}
for j, v in latest.items():
    latest_out[j] = {
        'tat':        v['tat'],
        'date':       v['dt'].strftime('%b %d, %Y %H:%M'),
        'search':     v['search'],
        'completion': v['completion'],
    }

# ── Parse Outliers sheet (if Excel with multiple sheets) ─────────────────
# Maps jurisdiction -> list of {tat, reason, search}
outliers_by_jur = defaultdict(list)
if suffix in ('.xlsx', '.xlsm') and not args.admin_upload:
    try:
        import openpyxl as _opx
        _wb = _opx.load_workbook(str(IN_FILE), read_only=True, data_only=True)
        _ws = None
        for _sn in _wb.sheetnames:
            if 'outlier' in _sn.lower(): _ws = _wb[_sn]; break
        if _ws:
            _rows = _ws.iter_rows(values_only=True)
            _hdr  = {str(h).strip().lower(): i for i,h in enumerate(next(_rows, [])) if h}
            def _g(row, key):
                i = _hdr.get(key)
                return str(row[i]).strip() if i is not None and i < len(row) and row[i] else ''
            for r in _rows:
                jur    = _g(r,'jurisdiction')
                jur    = resolver.resolve(jur)[0] or jur
                reason = _g(r,'reason')
                tat    = safe_float(_g(r,'search tat'))
                if jur and reason:
                    outliers_by_jur[jur].append({
                        'tat':    tat,
                        'reason': reason,
                        'search': _g(r,'search name'),
                    })
        _wb.close()
    except Exception as e:
        print(f'Outliers sheet skipped: {e}')

# ── Statewide averages ────────────────────────────────────────────────────
# Group ALL rows by state prefix (e.g. 'MT-Lincoln County' → 'MT')
# and compute average TAT across every search in that state.
state_avg = {}
for st, vals in state_all_tats.items():
    periods = {p: compute_stats(v) for p, v in state_period_tats[st].items()}
    state_avg[st] = {
        'avg':     round(vals.average(), 6),
        'count':   vals.count,
        'periods': periods,
    }

# Rank states by avg TAT (ascending = faster is better, rank 1 = fastest)
state_ranked = sorted(state_avg.items(), key=lambda x: x[1]['avg'])
state_total  = len(state_ranked)
for rank, (st, _) in enumerate(state_ranked, 1):
    state_avg[st]['rank']  = rank
    state_avg[st]['total'] = state_total

# ── Match jurisdictions to FIPS ───────────────────────────────────────────
sm_map = {fips: fips for fips in county_db if fips in period_stats or fips in precomp}

for fips, jur in sm_map.items():
    county_db[fips]['periods']  = period_stats.get(jur)
    county_db[fips]['types']    = type_stats.get(jur)
    county_db[fips]['trend']    = trends.get(jur, 0)
    county_db[fips]['latest']   = latest_out.get(jur)
    county_db[fips]['precomp']  = precomp.get(jur)
    county_db[fips]['outliers'] = outliers_by_jur.get(jur) or None

# Attach state avg to every county (whether matched or not)
for fips, c in county_db.items():
    st = c.get('state', '')
    c['state_avg'] = state_avg.get(st)  # None if no data for that state

# ── Preserve admin overrides ──────────────────────────────────────────────
existing_file = DATA_DIR / "county-data.json"
if existing_file.exists():
    with open(existing_file) as f:
        existing = json.load(f)
    for fips, c in existing.get('counties', {}).items():
        if fips not in county_db:
            continue
        target = county_db[fips]
        if c.get('_admin_override'):
            target['status']          = c['status']
            target['description']     = c['description']
            target['_admin_override'] = True
            if c.get('_overrides'):
                target['_overrides'] = c['_overrides']
        elif c.get('_desc_doc'):
            # Preserve the most recently approved closure/delay document until a
            # newer document is supplied. Capture the reconstructed base values
            # so a removed closure can revert cleanly on the next document import.
            target['_desc_doc_previous_status'] = c.get(
                '_desc_doc_previous_status', target['status']
            )
            target['_desc_doc_previous_description'] = c.get(
                '_desc_doc_previous_description', target['description']
            )
            target['status']      = c.get('status', target['status'])
            target['description'] = c.get('description', target['description'])
            target['_desc_doc']   = True

# ── Write output ──────────────────────────────────────────────────────────
out = {
    'maxDate':     max_date.strftime('%Y-%m-%d'),
    'isNewFormat': is_new_format,
    'stateAvg':    state_avg,   # top-level for easy frontend lookup
    'counties':    county_db,
    'reportRowCount': row_count,
    'reportCompletedThrough': completed_through.isoformat(sep=' ') if completed_through else None,
}
if existing_file.exists() and existing.get('closureSourceDate'):
    out['closureSourceDate'] = existing['closureSourceDate']
write_public_json_atomic(DATA_DIR / "county-data.json", out)

if unmatched:
    print('Unmatched jurisdictions: ' + json.dumps(dict(sorted(unmatched.items()))))
matched_states = len(state_avg)
print(f"Done. {len(sm_map)} counties matched | {len(set(list(period_stats.keys())+list(precomp.keys())))} unique jurisdictions | {matched_states} states with avg data. Max date: {max_date.date()}")
