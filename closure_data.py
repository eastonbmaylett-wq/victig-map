"""Parse and reconcile Victig's authoritative court-delay document."""

from __future__ import annotations

import io
import re
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Any, Iterable


STATE_NAMES_FULL = {
    "ALABAMA", "ALASKA", "ARIZONA", "ARKANSAS", "CALIFORNIA", "COLORADO",
    "CONNECTICUT", "DELAWARE", "FLORIDA", "GEORGIA", "HAWAII", "IDAHO",
    "ILLINOIS", "INDIANA", "IOWA", "KANSAS", "KENTUCKY", "LOUISIANA",
    "MAINE", "MARYLAND", "MASSACHUSETTS", "MICHIGAN", "MINNESOTA",
    "MISSISSIPPI", "MISSOURI", "MONTANA", "NEBRASKA", "NEVADA",
    "NEW HAMPSHIRE", "NEW JERSEY", "NEW MEXICO", "NEW YORK",
    "NORTH CAROLINA", "NORTH DAKOTA", "OHIO", "OKLAHOMA", "OREGON",
    "PENNSYLVANIA", "RHODE ISLAND", "SOUTH CAROLINA", "SOUTH DAKOTA",
    "TENNESSEE", "TEXAS", "UTAH", "VERMONT", "VIRGINIA", "WASHINGTON",
    "WEST VIRGINIA", "WISCONSIN", "WYOMING",
}

STATE_ABBREV = {
    "ALABAMA": "AL", "ALASKA": "AK", "ARIZONA": "AZ", "ARKANSAS": "AR",
    "CALIFORNIA": "CA", "COLORADO": "CO", "CONNECTICUT": "CT",
    "DELAWARE": "DE", "FLORIDA": "FL", "GEORGIA": "GA", "HAWAII": "HI",
    "IDAHO": "ID", "ILLINOIS": "IL", "INDIANA": "IN", "IOWA": "IA",
    "KANSAS": "KS", "KENTUCKY": "KY", "LOUISIANA": "LA", "MAINE": "ME",
    "MARYLAND": "MD", "MASSACHUSETTS": "MA", "MICHIGAN": "MI",
    "MINNESOTA": "MN", "MISSISSIPPI": "MS", "MISSOURI": "MO",
    "MONTANA": "MT", "NEBRASKA": "NE", "NEVADA": "NV",
    "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM",
    "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND",
    "OHIO": "OH", "OKLAHOMA": "OK", "OREGON": "OR", "PENNSYLVANIA": "PA",
    "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD",
    "TENNESSEE": "TN", "TEXAS": "TX", "UTAH": "UT", "VERMONT": "VT",
    "VIRGINIA": "VA", "WASHINGTON": "WA", "WEST VIRGINIA": "WV",
    "WISCONSIN": "WI", "WYOMING": "WY",
}

SKIP_PARAS = {
    "NEW UPDATES", "ONGOING/GENERAL COURT DELAYS", "DEAR CLIENT PARTNERS,",
    "SINCERELY,", "PLEASE LET US KNOW", "IT'S AN HONOR", "THANK YOU",
}

CLOSED_KEYWORDS = (
    "closed indefinitely", "closed for", "courthouse is closed", "inaccessible",
    "no access", "shut down", "closed due", "operations ceased", "closed until",
    "closed effective", "not yet resumed", "have not resumed",
    "court systems are down", "court system is down",
)

IGNORE_DESCRIPTION_KEYWORDS = (
    "motor vehicle report",
    "mvr",
)

DOC_MARKER = "_desc_doc"
PREVIOUS_STATUS = "_desc_doc_previous_status"
PREVIOUS_DESCRIPTION = "_desc_doc_previous_description"


class _ClosureHTMLTextParser(HTMLParser):
    """Convert the client bulletin HTML into paragraph-like plain text."""

    _BLOCK_TAGS = {
        "address", "article", "br", "div", "footer", "h1", "h2", "h3",
        "h4", "h5", "h6", "header", "li", "p", "section", "table", "td",
        "th", "tr",
    }
    _IGNORED_TAGS = {"head", "script", "style"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._ignored_depth = 0
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        tag = tag.lower()
        if tag in self._IGNORED_TAGS:
            self._ignored_depth += 1
        elif not self._ignored_depth and tag in self._BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in self._IGNORED_TAGS:
            self._ignored_depth = max(0, self._ignored_depth - 1)
        elif not self._ignored_depth and tag in self._BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._ignored_depth:
            self._parts.append(data)

    def text(self) -> str:
        return "\n".join(
            re.sub(r"\s+", " ", line).strip()
            for line in "".join(self._parts).splitlines()
            if line.strip()
        )


def desc_docx_text(raw_bytes: bytes) -> str:
    """Extract readable text from the court-delay Word document."""
    with zipfile.ZipFile(io.BytesIO(raw_bytes)) as archive:
        xml_data = archive.read("word/document.xml").decode("utf-8")
    root = ET.fromstring(xml_data)
    word_namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    paragraphs = []
    for paragraph in root.iter(f"{{{word_namespace}}}p"):
        value = "".join(
            run.text or "" for run in paragraph.iter(f"{{{word_namespace}}}t")
        ).strip()
        if value:
            paragraphs.append(value)
    return "\n".join(paragraphs)


def parse_desc_docx(raw_bytes: bytes) -> list[tuple[str, str | None, str]]:
    """Parse the court-delay Word document into state/county/description entries."""
    return parse_desc_text(desc_docx_text(raw_bytes))


def parse_desc_text(raw_text: str) -> list[tuple[str, str | None, str]]:
    """Parse plain text exported from the same court-delay document."""
    return _parse_desc_paragraphs(
        line.strip() for line in raw_text.splitlines() if line.strip()
    )


def html_to_desc_text(raw_html: str) -> str:
    """Extract paragraph-like text from a Mailjet/HTML client bulletin."""
    parser = _ClosureHTMLTextParser()
    parser.feed(raw_html)
    parser.close()
    return parser.text()


def parse_desc_html(raw_html: str) -> list[tuple[str, str | None, str]]:
    """Parse the HTML body of the authoritative court-delay email bulletin."""
    return parse_desc_text(html_to_desc_text(raw_html))


def extract_closure_source_date(raw_text: str) -> date:
    """Read the bulletin date embedded in its subject/title text."""
    month_pattern = (
        r"(January|February|March|April|May|June|July|August|September|"
        r"October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})"
    )
    match = re.search(month_pattern, raw_text, flags=re.IGNORECASE)
    if match:
        return datetime.strptime(
            f"{match.group(1)} {match.group(2)} {match.group(3)}", "%B %d %Y"
        ).date()
    iso_match = re.search(r"\b(20\d{2}-\d{2}-\d{2})\b", raw_text)
    if iso_match:
        return datetime.strptime(iso_match.group(1), "%Y-%m-%d").date()
    raise ValueError("Closure bulletin date was not found in its title or content")


def validate_closure_source_date(
    source_date: date,
    *,
    previous_date: str | None = None,
    max_age_days: int = 14,
    today: date | None = None,
) -> None:
    """Reject stale, future-dated, or regressive closure bulletins."""
    current_date = today or datetime.now(timezone.utc).date()
    if source_date > current_date + timedelta(days=1):
        raise ValueError("Closure bulletin date is unexpectedly in the future")
    if source_date < current_date - timedelta(days=max_age_days):
        raise ValueError(
            f"Closure bulletin is older than the allowed {max_age_days}-day window"
        )
    if previous_date:
        try:
            prior = datetime.strptime(previous_date, "%Y-%m-%d").date()
        except ValueError as error:
            raise ValueError("Existing closureSourceDate is invalid") from error
        if source_date < prior:
            raise ValueError("Closure bulletin date regressed")


def _parse_desc_paragraphs(
    paragraphs: Iterable[str],
) -> list[tuple[str, str | None, str]]:

    results: list[tuple[str, str | None, str]] = []
    current_state: str | None = None
    current_county: str | None = None
    county_paragraphs: list[str] = []

    def flush_county() -> None:
        nonlocal current_county, county_paragraphs
        if county_paragraphs and current_state and current_county:
            state = STATE_ABBREV.get(current_state)
            if state:
                results.append((state, current_county, " ".join(county_paragraphs)))
        current_county = None
        county_paragraphs = []

    county_marker_re = re.compile(r"\bCOUNT(?:Y|IES)\b")

    def county_names_before_markers(paragraph: str) -> list[str]:
        names: list[str] = []
        for marker in county_marker_re.finditer(paragraph):
            prefix = paragraph[:marker.start()].rstrip()
            match = re.search(
                r"([A-Z][A-Z .'-]*(?:(?:,\s*|\s+and\s+)[A-Z][A-Z .'-]*)*)$",
                prefix,
            )
            if not match:
                continue
            raw_list = re.sub(r"^ALL\s+", "", match.group(1).strip())
            for part in re.split(r",\s*|\s+and\s+", raw_list):
                name = part.strip().upper()
                if (
                    2 <= len(name) <= 40
                    and re.fullmatch(r"[A-Z .'-]+", name)
                    and name != current_state
                ):
                    names.append(name)
        return names

    def trailing_county_list(paragraph: str) -> list[str]:
        if "counties" not in paragraph.lower():
            return []
        match = re.search(
            r"\b(?:in|include|including)\s+"
            r"([A-Z][A-Z .'-]*(?:(?:,\s*|\s+and\s+)[A-Z][A-Z .'-]*)*)\s*[.]?$",
            paragraph,
        )
        if not match:
            return []
        return [
            part.strip().upper()
            for part in re.split(r",\s*|\s+and\s+", match.group(1))
            if 2 <= len(part.strip()) <= 40
            and re.fullmatch(r"[A-Z .'-]+", part.strip().upper())
        ]

    for paragraph in paragraphs:
        upper = paragraph.upper().strip()
        normalized_upper = upper.replace("\u2019", "'").replace("\u2018", "'")
        if normalized_upper.startswith(("KIND REGARDS", "THIS E-MAIL HAS BEEN SENT")):
            flush_county()
            break
        if normalized_upper in SKIP_PARAS:
            continue
        if any(skip in normalized_upper for skip in SKIP_PARAS):
            continue
        if any(keyword in paragraph.lower() for keyword in IGNORE_DESCRIPTION_KEYWORDS):
            continue

        if upper in STATE_NAMES_FULL:
            flush_county()
            current_state = upper
            continue
        if not current_state:
            continue
        state = STATE_ABBREV.get(current_state)
        if not state:
            continue

        if len(paragraph) <= 50 and re.fullmatch(r"[A-Z][A-Z\s.'-]+:?", paragraph):
            flush_county()
            current_county = re.sub(r"\s+COUNTY$", "", upper.rstrip(":")).strip()
            continue
        if len(paragraph) < 20:
            continue

        marker_counties = county_names_before_markers(paragraph)
        if marker_counties:
            flush_county()
            results.extend((state, county, paragraph) for county in marker_counties)
            continue

        municipal_match = re.search(
            r"\b([A-Z][A-Z .'-]{2,40})\s+(?:MUNICIPAL|DISTRICT)\s+COURT",
            paragraph,
        )
        if municipal_match:
            flush_county()
            results.append((state, municipal_match.group(1).strip(), paragraph))
            continue

        trailing_counties = trailing_county_list(paragraph)
        if trailing_counties:
            flush_county()
            results.extend((state, county, paragraph) for county in trailing_counties)
            continue

        if len(paragraph) >= 30:
            if current_county is not None:
                county_paragraphs.append(paragraph)
            else:
                results.append((state, None, paragraph))

    flush_county()
    return results


def _norm(value: str) -> str:
    return re.sub(r"[^a-z]", "", value.lower())


def _combine_entries(
    entries: Iterable[tuple[str, str | None, str]],
) -> dict[tuple[str, str | None], str]:
    grouped: dict[tuple[str, str | None], list[str]] = defaultdict(list)
    for state, county, description in entries:
        clean_description = description.strip()
        if clean_description:
            key = (state.upper(), county.upper().strip() if county else None)
            if clean_description not in grouped[key]:
                grouped[key].append(clean_description)
    return {key: " ".join(parts) for key, parts in grouped.items()}


def _clear_document_entry(county: dict[str, Any]) -> None:
    previous_description = county.pop(PREVIOUS_DESCRIPTION, "")
    previous_status = county.pop(PREVIOUS_STATUS, None)
    county["description"] = previous_description
    if previous_status:
        county["status"] = previous_status
    elif county.get("status") in {"closed", "delay"}:
        county["status"] = "ok"
    county.pop(DOC_MARKER, None)


def _apply_document_entry(county: dict[str, Any], description: str) -> None:
    county[PREVIOUS_STATUS] = county.get("status", "ok")
    county[PREVIOUS_DESCRIPTION] = county.get("description", "")
    county["description"] = description
    county[DOC_MARKER] = True
    if any(keyword in description.lower() for keyword in CLOSED_KEYWORDS):
        county["status"] = "closed"
    elif county.get("status") == "ok":
        county["status"] = "delay"


def apply_closure_entries(
    data: dict[str, Any],
    entries: Iterable[tuple[str, str | None, str]],
) -> dict[str, Any]:
    """Replace document-managed delay entries while preserving manual overrides."""
    counties = data.get("counties")
    if not isinstance(counties, dict):
        raise ValueError("county dataset is missing counties")

    cleared = 0
    for county in counties.values():
        if not isinstance(county, dict) or not county.get(DOC_MARKER):
            continue
        if county.get("_admin_override"):
            # Legacy data may have both markers. Treat the explicit admin marker as authority.
            county.pop(DOC_MARKER, None)
            county.pop(PREVIOUS_STATUS, None)
            county.pop(PREVIOUS_DESCRIPTION, None)
            continue
        _clear_document_entry(county)
        cleared += 1

    lookup: dict[str, str] = {}
    for fips, county in counties.items():
        if not isinstance(county, dict):
            continue
        state = str(county.get("state") or "").upper()
        name = str(county.get("name") or "")
        if state and name:
            lookup[_norm(state + name)] = fips

    combined = _combine_entries(entries)
    specific_fips: set[str] = set()
    skipped: list[str] = []
    updated = 0
    closed = 0
    manual_preserved = 0

    for (state, county_name), description in combined.items():
        if county_name is None:
            continue
        fips = lookup.get(_norm(state + county_name))
        if not fips:
            skipped.append(f"{state}-{county_name}")
            continue
        specific_fips.add(fips)
        county = counties[fips]
        if county.get("_admin_override"):
            manual_preserved += 1
            continue
        _apply_document_entry(county, description)
        updated += 1
        closed += int(county.get("status") == "closed")

    for (state, county_name), description in combined.items():
        if county_name is not None:
            continue
        for fips, county in counties.items():
            if (
                not isinstance(county, dict)
                or str(county.get("state") or "").upper() != state
                or fips in specific_fips
            ):
                continue
            if county.get("_admin_override"):
                manual_preserved += 1
                continue
            _apply_document_entry(county, description)
            updated += 1
            closed += int(county.get("status") == "closed")

    return {
        "documentEntries": len(combined),
        "updated": updated,
        "closed": closed,
        "cleared": cleared,
        "skipped": len(skipped),
        "skippedJurisdictions": skipped,
        "manualPreserved": manual_preserved,
    }
