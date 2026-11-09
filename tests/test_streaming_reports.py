import csv
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import openpyxl

ROOT = Path(__file__).resolve().parents[1]


class StreamingReportTests(unittest.TestCase):
    def run_report(self, report, directory, *arguments, descriptor=False):
        environment = dict(os.environ, DATA_DIR=directory)
        # Reproduce Lambda's missing descriptor filesystem even on a Mac that
        # provides /dev/fd. Integer descriptors must work without either alias.
        if descriptor:
            original_site = getattr(sys.modules.get('sitecustomize'), '__file__', '')
            (Path(directory) / 'sitecustomize.py').write_text(f'''
import sys, runpy
original = {original_site!r}
if original:
    runpy.run_path(original)
def reject_descriptor_paths(event, args):
    if event == 'open' and isinstance(args[0], str) and args[0].startswith(('/dev/fd/', '/proc/self/fd/')):
        raise FileNotFoundError('Descriptor paths are unavailable in this runtime')
sys.addaudithook(reject_descriptor_paths)
''')
            environment['PYTHONPATH'] = os.pathsep.join(filter(None, [directory, environment.get('PYTHONPATH')]))
        with open(report, 'rb') as source:
            input_args = ['--input-fd', str(source.fileno())] if descriptor else [str(report)]
            result = subprocess.run([sys.executable, str(ROOT / 'process.py'), *input_args, *arguments],
                env=environment, capture_output=True, text=True,
                pass_fds=(source.fileno(),) if descriptor else ())
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads((Path(directory) / 'county-data.json').read_text())

    def test_unsorted_rows_period_boundaries_types_trends_and_all_time_state_average(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / 'report.csv'
            # The last row is the report max date. A forward-only rolling window
            # must not accidentally use an earlier row as its date anchor.
            report.write_text('Synthetic export preamble\nJurisdiction,Search TAT,Start Date/Time,Search Name\n'
                'CT-Fairfield County,9,2026-05-12 10:00:00,County Criminal Records Search\n'
                'CT-Fairfield County,7,2026-09-10 10:00:00,County Criminal Records Search\n'
                'CT-Fairfield County,5,2026-10-10 09:59:59,County Criminal Records Search\n'
                'CT-Fairfield County,3,2026-10-10 10:00:00,County Criminal Records Search\n'
                'CONNECTICUT,11,2026-11-08 10:00:00,State Criminal Court Search\n'
                'CT-Fairfield County,1,2026-11-09 10:00:00,County Criminal Records Search\n')
            data = self.run_report(report, directory, '--format', '.csv', '--admin-upload', descriptor=True)
            county = data['counties']['09001']
            self.assertEqual(data['reportRowCount'], 6)
            self.assertEqual(data['maxDate'], '2026-11-09')
            # Legacy periods use timedelta.days (whole days), including 30d + 1s.
            self.assertEqual(county['periods']['30d']['count'], 3)
            self.assertEqual(county['periods']['30d']['avg'], 3)
            self.assertEqual(county['periods']['60d']['avg'], 4)
            self.assertEqual(county['types']['county_criminal']['count'], 4)
            self.assertEqual(county['trend'], 1)
            self.assertEqual(data['stateAvg']['CT']['count'], 6)
            self.assertEqual(data['stateAvg']['CT']['avg'], 6)

    def test_admin_excel_descriptor_keeps_sheet_selection_and_raw_date_calculation(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / 'report.xlsx'
            workbook = openpyxl.Workbook()
            workbook.active.title = 'TAT Outliers'
            workbook.active.append(['Do not import this sheet'])
            sheet = workbook.create_sheet('Turnaround Report')
            sheet.append(['Jurisdiction', 'Start Date/Time', 'Completion Date/Time', 'Search Name'])
            sheet.append(['CT-Fairfield County', '2026-11-07 10:00:00', '2026-11-09 10:00:00', 'County Criminal Records Search'])
            workbook.save(report)
            workbook.close()
            data = self.run_report(report, directory, '--format', '.xlsx', '--admin-upload', descriptor=True)
            self.assertEqual(data['reportRowCount'], 1)
            self.assertEqual(data['counties']['09001']['periods']['90d']['avg'], 2)
            self.assertEqual(data['reportCompletedThrough'], '2026-11-09 10:00:00')

    def test_tab_separated_reports_with_quoted_newlines(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / 'report.tsv'
            with report.open('w', newline='') as output:
                writer = csv.writer(output, delimiter='\t')
                writer.writerow(['Jurisdiction', 'Search TAT', 'Start Date/Time', 'Search Name', 'Ignored'])
                writer.writerow(['CT-Fairfield County', '2.5', '11/09/2026 10:00', 'County Criminal Records Search', 'Line 1\nLine 2'])
            data = self.run_report(report, directory, '--admin-upload')
            self.assertEqual(data['reportRowCount'], 1)
            self.assertEqual(data['counties']['09001']['periods']['30d']['avg'], 2.5)
