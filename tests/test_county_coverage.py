from collections import Counter
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from jurisdiction import JurisdictionResolver

ROOT = Path(__file__).resolve().parents[1]


class CountyCoverageTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT / 'county-data.json').read_text())
        self.resolver = JurisdictionResolver(self.data['counties'])

    def test_each_record_has_one_matching_boundary(self):
        topology = json.loads((ROOT / 'counties-10m.json').read_text())
        geometries = topology['objects']['counties']['geometries']
        counts = Counter(g['id'] for g in geometries)
        self.assertEqual(set(counts), set(self.data['counties']))
        self.assertEqual(set(counts.values()), {1})
        for g in geometries:
            self.assertEqual(g['properties']['name'].casefold(), self.data['counties'][g['id']]['name'].casefold())
        self.assertNotIn('02261', counts)
        self.assertIn('02063', counts)
        self.assertIn('02066', counts)

    def test_saint_accent_and_legal_suffix_aliases(self):
        pairs = {'FL-SAINT LUCIE':'12111','MO-SAINT LOUIS':'29189',
                 'MO-SAINT LOUIS CITY':'29510','NM-DONA ANA':'35013',
                 'MO-SAINTE GENEVIEVE':'29186','VI-SAINT CROIX':'78010',
                 'LA-SAINT MARY Parish':'22101','AK-Copper River Census Area':'02066'}
        for jur, expected in pairs.items():
            with self.subTest(jur=jur):
                self.assertEqual(self.resolver.resolve(jur)[0], expected)

    def test_city_and_county_are_distinct(self):
        for state, name, county, city in [('MD','Baltimore','24005','24510'),
            ('VA','Richmond','51159','51760'),('VA','Fairfax','51059','51600'),
            ('VA','Roanoke','51161','51770'),('VA','Franklin','51067','51620')]:
            self.assertEqual(self.resolver.resolve(f'{state}-{name}')[0], county)
            self.assertEqual(self.resolver.resolve(f'{state}-{name} County')[0], county)
            self.assertEqual(self.resolver.resolve(f'{state}-{name} City')[0], city)
        self.assertEqual(self.resolver.resolve('VA-Alexandria')[0], '51510')
        self.assertEqual(self.resolver.resolve('NV-Carson City')[0], '32510')
        self.assertEqual(self.resolver.resolve('VA-Charles City')[0], '51036')
        self.assertEqual(self.resolver.resolve('VA-James City')[0], '51095')
        self.assertIsNone(self.resolver.resolve('AK-Valdez-Cordova')[0])

    def test_statewide_does_not_become_county_data(self):
        for jur, state in [('ALASKA','AK'),('NY-NYOCA','NY'),('PUERTO RICO','PR'),
                           ('UT-Statewide','UT'),('DISTRICT OF COLUMBIA','DC')]:
            self.assertEqual(self.resolver.resolve(jur), ('STATE:'+state,state))

    def test_import_merges_alias_rows_and_keeps_notices(self):
        report = ('Jurisdiction,Search TAT,Start Date/Time,Completion Date/Time,Search Name\n'
            'FL-SAINT LUCIE,2,2026-11-04 09:00:00,2026-11-05 09:00:00,County Criminal Records Search\n'
            'FL-St. Lucie County,4,2026-11-04 10:00:00,2026-11-05 10:00:00,County Criminal Records Search\n'
            'FLORIDA,9,2026-11-04 11:00:00,2026-11-05 11:00:00,State Criminal Court Search\n'
            'MD-Baltimore,3,2026-11-04 09:00:00,2026-11-05 09:00:00,County Criminal Records Search\n'
            'MD-Baltimore City,7,2026-11-04 09:00:00,2026-11-05 09:00:00,County Criminal Records Search\n')
        outputs=[]
        for seed in ['7','19']:
            with tempfile.TemporaryDirectory() as directory:
                path=Path(directory)
                (path/'input.csv').write_text(report)
                note={'counties':{'12111':{'_admin_override':True,'status':'delay','description':'Keep this human note'}}}
                (path/'county-data.json').write_text(json.dumps(note))
                result=subprocess.run([sys.executable,str(ROOT/'process.py'),str(path/'input.csv')],
                    env=dict(os.environ,DATA_DIR=directory,PYTHONHASHSEED=seed),capture_output=True,text=True)
                self.assertEqual(result.returncode,0,result.stderr)
                outputs.append(json.loads((path/'county-data.json').read_text()))
        self.assertEqual(outputs[0],outputs[1])
        out=outputs[0]; c=out['counties']
        self.assertEqual(c['12111']['periods']['90d']['avg'],3)
        self.assertEqual(c['12111']['periods']['90d']['count'],2)
        self.assertEqual(c['12111']['description'],'Keep this human note')
        self.assertEqual(c['24005']['periods']['90d']['avg'],3)
        self.assertEqual(c['24510']['periods']['90d']['avg'],7)
        self.assertEqual(out['stateAvg']['FL']['avg'],5)
        self.assertEqual(out['reportRowCount'],5)
        self.assertEqual(out['reportCompletedThrough'],'2026-11-05 11:00:00')
        self.assertEqual(c['12111']['periods']['90d']['total'],3)
