"""Deterministic county identity for Taz jurisdiction names."""
import re
import unicodedata
from collections import defaultdict

STATE_NAMES = dict(zip(
    ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI').split(),
    ('Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|District of Columbia|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|American Samoa|Guam|Northern Mariana Islands|Puerto Rico|Virgin Islands').split('|')))


def normalize(value):
    value = unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode().lower()
    value = re.sub(r'\bsaint\b', 'st', value)
    value = re.sub(r'\bsainte\b', 'ste', value)
    return re.sub(r'[^a-z0-9]', '', value)


def is_independent_city(fips):
    return (fips.startswith('51') and int(fips[2:]) >= 500) or fips in {'24510', '29510', '32510'}


class JurisdictionResolver:
    def __init__(self, counties):
        self.counties = counties
        self.by_name = defaultdict(list)
        self.states = {normalize(v): k for k, v in STATE_NAMES.items()}
        self.states.update({normalize(k): k for k in STATE_NAMES})
        self.states['usvirginislands'] = 'VI'
        for fips, county in counties.items():
            self.by_name[(county['state'], normalize(county['name']))].append(fips)

    def resolve(self, jurisdiction, search_type='county_criminal'):
        """Return (canonical key, state); never map an ambiguous city to a county."""
        text = jurisdiction.strip()
        state = self.states.get(normalize(text))
        if state:
            return 'STATE:' + state, state
        if '-' not in text:
            return None, None
        prefix, place = text.split('-', 1)
        state = self.states.get(normalize(prefix))
        if not state:
            return None, None
        name = normalize(place)
        if name in {'statewide', 'state', 'nyoca'} or name == normalize(STATE_NAMES[state]):
            return 'STATE:' + state, state
        # First keep exact names, including Carson City, before dropping legal suffixes.
        exact = self.by_name.get((state, name), [])
        # Charles City and James City are county names, not independent cities.
        if len(exact) == 1:
            return exact[0], state
        city = bool(re.search(r'\bcity\s*$', place, re.I))
        county = bool(re.search(r'\b(county|parish|borough|census area|municipality)\s*$', place, re.I))
        stripped = re.sub(r'\s+(county|parish|borough|census area|municipality|city)\s*$', '', place, flags=re.I)
        choices = exact or self.by_name.get((state, normalize(stripped)), [])
        if city:
            choices = [f for f in choices if is_independent_city(f)]
        elif county or len(choices) > 1:
            choices = [f for f in choices if not is_independent_city(f)]
        if len(choices) == 1:
            return choices[0], state
        return None, state
