"""OpenStreetMap stop-name enrichment."""
import json
import urllib.request
from urllib.parse import urlencode

from .config import (
    OSM_URL, OSM_NETWORK_NAME, OSM_STOP_TYPES, DATA_DIR,
    normalize, normalize_osm_stop_code, normalize_stop_id,
)

def fetch_osm_stops():
    """Fetch public transport stop names from OSM; GTFS remains the fallback."""

    elements = "".join(
        f'node[{transport_type}=yes][public_transport={public_transport}]'
        f'[ref][network="{OSM_NETWORK_NAME}"];'
        for transport_type, public_transport in OSM_STOP_TYPES
    )
    query = (
        "[out:json][timeout:50];"
        f"({elements});"
        "out body;"
    )
    request = urllib.request.Request(
        OSM_URL,
        data=urlencode({"data": query}).encode("utf-8"),
        headers={
            "User-Agent": "GTSofia transport data generator",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=70) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as error:
        # None means the request failed. The pipeline can then retain the last
        # known-good OSM names instead of overwriting them with GTFS names.
        print(f"WARNING: Could not fetch OSM stop names: {error}")
        return None

    elements = payload.get("elements", [])

    # Match Dimitar's preference for platform objects over stop positions
    # when both OSM objects share the same public stop code.
    priority = {
        "station": 0,
        "stop_position": 1,
        "platform": 2,
    }
    elements.sort(
        key=lambda element: priority.get(
            normalize((element.get("tags") or {}).get("public_transport")),
            99,
        )
    )

    result = {}

    for element in elements:
        tags = element.get("tags") or {}
        code = normalize_osm_stop_code(tags)

        if not code:
            continue

        name = normalize(tags.get("name") or tags.get("name:bg"))
        name_en = normalize(tags.get("name:en"))

        # Keep the record even if OSM has no name: a later GTFS fallback is
        # still possible and the extra OSM references can be useful metadata.
        result[code] = {
            "osm_stop_name": name,
            "osm_stop_name_en": name_en,
            "osm_short_name_bg": normalize(tags.get("short_name:bg")),
            "osm_short_name_en": normalize(tags.get("short_name:en")),
            "osm_full_name_bg": normalize(tags.get("full_name:bg")),
            "osm_full_name_en": normalize(tags.get("full_name:en")),
            "osm_local_ref": normalize(tags.get("local_ref")),
            "osm_metro_ref": normalize(tags.get("local_ref:metro")),
            "osm_request_stop": normalize(tags.get("request_stop")).lower() == "yes",
            "osm_type": normalize(element.get("type")),
            "osm_id": normalize(element.get("id")),
        }

    print(f"OSM stops with public refs: {len(result)}")
    return result



def previous_osm_stops_from_rows(stops_rows):
    """Build an OSM lookup from the last generated stops.json snapshot."""

    previous = {}
    osm_fields = (
        "osm_stop_name", "osm_stop_name_en",
        "osm_short_name_bg", "osm_short_name_en",
        "osm_full_name_bg", "osm_full_name_en",
        "osm_local_ref", "osm_metro_ref",
        "osm_request_stop", "osm_type", "osm_id",
    )

    for row in stops_rows or []:
        if not isinstance(row, dict):
            continue

        osm_name = normalize(row.get("osm_stop_name"))
        if not osm_name:
            continue

        record = {field: row.get(field) for field in osm_fields if field in row}
        # Older generated records may not contain all metadata fields.
        record["osm_stop_name"] = osm_name

        keys = {
            normalize_stop_id(row.get("stop_id")),
            normalize_stop_id(row.get("stop_code")),
        }
        for key in keys - {""}:
            previous[key] = dict(record)

    return previous


def merge_osm_stop_snapshots(current_osm_stops, previous_osm_stops):
    """Merge a fresh OSM response over the last known-good OSM snapshot.

    OSM responses can be partial when an Overpass mirror is under load.
    Missing records therefore retain their previous names. Fresh named records
    always take precedence. A nameless fresh record also keeps a previous name
    when one exists, avoiding mass regressions from incomplete OSM responses.
    """

    merged = {
        key: dict(value)
        for key, value in (previous_osm_stops or {}).items()
        if key and isinstance(value, dict)
    }

    for key, fresh_value in (current_osm_stops or {}).items():
        if not key or not isinstance(fresh_value, dict):
            continue

        previous_value = merged.get(key, {})
        record = {**previous_value, **fresh_value}

        if (
            not normalize(fresh_value.get("osm_stop_name"))
            and normalize(previous_value.get("osm_stop_name"))
        ):
            record["osm_stop_name"] = previous_value["osm_stop_name"]

        merged[key] = record

    return merged


def load_previous_osm_stops():
    """Load last generated OSM names from data/stops.json, if available."""

    path = DATA_DIR / "stops.json"
    if not path.exists():
        return {}

    try:
        import json
        with path.open("r", encoding="utf-8") as file:
            rows = json.load(file)
    except (OSError, ValueError) as error:
        print(f"WARNING: Could not read previous stop-name snapshot: {error}")
        return {}

    return previous_osm_stops_from_rows(rows)

def enrich_stops_with_osm(stops_data, osm_stops):
    """Prefer OSM's public-facing Bulgarian name, preserving GTFS as fallback."""

    enriched = []

    for original in stops_data:
        row = dict(original)
        gtfs_name = normalize(row.get("stop_name"))
        row["gtfs_stop_name"] = gtfs_name

        stop_id = normalize_stop_id(row.get("stop_id"))
        stop_code = normalize_stop_id(row.get("stop_code"))
        osm = (osm_stops or {}).get(stop_id) or (osm_stops or {}).get(stop_code) or {}
        osm_name = normalize(osm.get("osm_stop_name"))

        row.update(osm)
        row["osm_stop_name"] = osm_name
        row["stop_name"] = osm_name or gtfs_name
        row["stop_name_source"] = "osm" if osm_name else "gtfs"

        enriched.append(row)

    return enriched

