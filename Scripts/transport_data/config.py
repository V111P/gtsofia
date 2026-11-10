"""Shared configuration and small utility functions."""
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

GTFS_URL = "https://gtfs.sofiatraffic.bg/api/v1/static"
OSM_URL = "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
OSM_NETWORK_NAME = "Градски транспорт София"
OSM_STOP_TYPES = (
    ("subway", "station"),
    ("tram", "stop_position"),
    ("bus", "platform"),
    ("trolleybus", "platform"),
)

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

    if normalize(tags.get("subway")).lower() == "yes":
        return f"M{ref}"

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


