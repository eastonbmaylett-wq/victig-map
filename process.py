#!/usr/bin/env python3
"""
Victig TAT Map — Data Processor
Usage: python3 process.py <path-to-csv>
Updates county-data.json in the same directory.
"""
import csv, json, io, re, sys
from datetime import datetime
from collections import defaultdict
from pathlib import Path

BASE = Path(__file__).parent
CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else str(BASE / "uploaded.csv")

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

def classify(s):
    s = s.lower()
    if 'county' in s and 'criminal' in s: return 'county_criminal'
    if 'state' in s and ('criminal' in s or 'court' in s or 'search' in s): return 'statewide'
    return 'other'

def compute_stats(vals):
    if not vals: return None
    return {'avg': round(sum(vals)/len(vals),2), 'max': round(max(vals),2),
            'min': round(min(vals),2), 'count': len(vals)}

# Read CSV
with open(CSV_PATH, newline='', encoding='utf-8-sig') as f:
    lines = f.readlines()
reader = csv.DictReader(io.StringIO(''.join(lines[1:])))

rows, latest = [], {}
for row in reader:
    jur = row.get('Jurisdiction','').strip()
    tat_str = row.get('Search TAT','').strip()
    date_str = row.get('Start Date/Time','').strip()
    search = row.get('Search Name','').strip()
    if not jur or not tat_str or not date_str: continue
    try:
        tat = float(tat_str)
        dt  = datetime.strptime(date_str, '%m/%d/%Y %H:%M')
        if tat >= 0:
            rows.append({'jur':jur,'tat':tat,'dt':dt,'type':classify(search)})
            if jur not in latest or dt > latest[jur]['dt']:
                latest[jur] = {'dt':dt,'tat':tat,'search':search}
    except: pass

max_date = max(r['dt'] for r in rows)

# Period stats
jur_periods = defaultdict(lambda: defaultdict(list))
jur_types   = defaultdict(lambda: defaultdict(list))
for r in rows:
    age = (max_date - r['dt']).days
    if age > 180: continue
    for label, days in [('30d',30),('60d',60),('90d',90),('180d',180)]:
        if age <= days: jur_periods[r['jur']][label].append(r['tat'])
    jur_types[r['jur']][r['type']].append(r['tat'])

# Trend
jur_trend = {}
for r in rows:
    age = (max_date - r['dt']).days
    if age > 60: continue
    jur = r['jur']
    if jur not in jur_trend: jur_trend[jur] = {'recent':[],'prior':[]}
    if age <= 30: jur_trend[jur]['recent'].append(r['tat'])
    elif age <= 60: jur_trend[jur]['prior'].append(r['tat'])

period_stats = {}
for jur, pdata in jur_periods.items():
    period_stats[jur] = {p: compute_stats(v) for p,v in pdata.items()}

for period in ['30d','60d','90d','180d']:
    ranked = sorted([(j,s[period]['avg']) for j,s in period_stats.items() if s.get(period)], key=lambda x:x[1])
    for rank,(jur,_) in enumerate(ranked,1):
        period_stats[jur][period]['rank'] = rank
        period_stats[jur][period]['total'] = len(ranked)

type_stats = {j:{t:compute_stats(v) for t,v in d.items()} for j,d in jur_types.items()}
trends = {}
for jur,d in jur_trend.items():
    if d['recent'] and d['prior']:
        diff = sum(d['prior'])/len(d['prior']) - sum(d['recent'])/len(d['recent'])
        trends[jur] = 0 if abs(diff)<0.1 else (1 if diff>0 else -1)

latest_out = {j:{'tat':v['tat'],'date':v['dt'].strftime('%b %d, %Y'),'search':v['search']} for j,v in latest.items()}

# Load SimpleMaps base data
sm_file = BASE / "simplemaps-base.json"
with open(sm_file) as f:
    map_data = json.load(f)

sm_lookup = {}
for fips, info in map_data.items():
    abbrev = STATE_FIPS.get(fips[:2],'')
    sm_lookup[f"{abbrev}-{info.get('name','').upper()}"] = fips

county_db = {}
for fips, info in map_data.items():
    abbrev = STATE_FIPS.get(fips[:2],'')
    county_db[fips] = {
        'fips':fips,'name':info.get('name',''),'state':abbrev,
        'status':COLOR_STATUS.get(info.get('color',''),'ok'),
        'description':info.get('description',''),
        'periods':None,'types':None,'trend':0,'latest':None
    }

sm_map = {}
for fips, c in county_db.items():
    state, name = c['state'], c['name'].upper()
    for jur in period_stats:
        if '-' not in jur: continue
        parts = jur.split('-',1)
        if parts[0] != state: continue
        county = parts[1].strip().upper()
        for suffix in ['',' COUNTY',' PARISH',' BOROUGH']:
            if re.sub(suffix+'$','',county).strip() == name:
                sm_map[fips] = jur; break

for fips, jur in sm_map.items():
    county_db[fips]['periods'] = period_stats.get(jur)
    county_db[fips]['types']   = type_stats.get(jur)
    county_db[fips]['trend']   = trends.get(jur,0)
    county_db[fips]['latest']  = latest_out.get(jur)

# Preserve any existing admin overrides
existing_file = BASE / "county-data.json"
if existing_file.exists():
    with open(existing_file) as f:
        existing = json.load(f)
    for fips, c in existing.get('counties',{}).items():
        if fips in county_db and c.get('_admin_override'):
            county_db[fips]['status']      = c['status']
            county_db[fips]['description'] = c['description']
            county_db[fips]['_admin_override'] = True

with open(BASE / "county-data.json", 'w') as f:
    json.dump({'maxDate': max_date.strftime('%Y-%m-%d'), 'counties': county_db}, f)

print(f"Done. {len(sm_map)} counties matched. Max date: {max_date.date()}")
