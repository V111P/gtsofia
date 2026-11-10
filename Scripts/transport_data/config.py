"""Shared configuration and small utility functions."""
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

GTFS_URL = "https://gtfs.sofiatraffic.bg/api/v1/static"
# maps.mail.ru's Overpass endpoint has had repeated availability/permission
# problems. Keep a primary endpoint and multiple public fallbacks so an
# outage cannot silently turn the generated stop names back into GTFS names.
OSM_URL = "https://overpass.private.coffee/api/interpreter"
OSM_FALLBACK_URLS = (
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass-api.de/api/interpreter",
)
OSM_NETWORK_NAME = "Градски транспорт София"
# Keep the older two-column setting for callers which import it, but use the
# explicit filters below to match the actual OSM tagging conventions.
OSM_STOP_TYPES = (
    ("subway", "station"),
    ("tram", "stop_position"),
    ("bus", "platform"),
    ("trolleybus", "platform"),
)
OSM_STOP_FILTERS = (
    # Subway stations are commonly mapped with railway=station, not
    # public_transport=station. Retain the latter for older mapped objects.
    ("station", "subway", "railway", "station"),
    ("subway", "yes", "railway", "station"),
    ("subway", "yes", "public_transport", "station"),
    ("tram", "yes", "public_transport", "stop_position"),
    ("tram", "yes", "railway", "tram_stop"),
    ("bus", "yes", "public_transport", "platform"),
    ("bus", "yes", "highway", "bus_stop"),
    ("trolleybus", "yes", "public_transport", "platform"),
)
# Match the repository's existing data-quality test: fewer than 3,000 named
# OSM records is treated as an incomplete fetch, not as a new source of truth.
OSM_MIN_NAMED_STOPS = 3000

# This file lives in Scripts/transport_data/, so the repository root is
# two levels above the package directory.
ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
GTFS_DIR = ROOT / ".gtfs"
LEGACY_OUTPUT_FILE = DATA_DIR / "transport.json"
CALENDAR_CONFIG_FILE = ROOT / "config" / "calendar.json"

SOFIA_TIME_ZONE = ZoneInfo("Europe/Sofia")
GTFS_WEEKDAY_FIELDS = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)

def normalize(value):
    return str(value).strip() if value is not None else ""


def normalize_stop_id(value):
    value = normalize(value)

    if not value:
        return ""

    if value.startswith("M"):
        return value

    digits = "".join(
        char
        for char in value
        if char.isdigit()
    )

    return digits.zfill(4)


def normalize_osm_stop_code(tags):
    """Use the same public stop-code convention as sofiatraffic-schedules."""

    ref = normalize(tags.get("ref"))

    if not ref:
        return ""

    is_subway = (
        normalize(tags.get("subway")).lower() == "yes"
        or normalize(tags.get("station")).lower() == "subway"
    )
    if is_subway:
        return f"M{ref[1:]}" if ref.upper().startswith("M") else f"M{ref}"

    return ref.zfill(4)


def parse_date(value):
    value = normalize(value)

    if not value:
        return None

    try:
        return datetime.strptime(
            value,
            "%Y%m%d"
        ).date()
    except ValueError:
        return None


def parse_time(value):
    value = normalize(value)

    if not value:
        return None

    try:
        hours, minutes, seconds = map(
            int,
            value.split(":")
        )

        return (
            hours * 3600
            + minutes * 60
            + seconds
        )

    except (
        TypeError,
        ValueError
    ):
        return None


def get_today():
    # GTFS service dates are evaluated in the agency's local time. Sofia's
    # official feed is published for Europe/Sofia, so never use UTC here:
    # around midnight UTC that could select the wrong service date.
    return datetime.now(
        SOFIA_TIME_ZONE
    ).date()


def gtfs_date_string(current):
    return current.strftime("%Y%m%d")


def iso_date_string(current):
    return current.isoformat()


