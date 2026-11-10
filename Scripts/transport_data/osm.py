"""OpenStreetMap stop-name enrichment."""
import json
import urllib.request
from urllib.parse import urlencode

from .config import (
    OSM_URL, OSM_USER_AGENT, OSM_NETWORK_NAME, OSM_STOP_TYPES,
    OSM_MIN_STOP_RECORDS, OSM_MIN_NAMED_STOP_RECORDS, DATA_DIR,
    normalize, normalize_osm_stop_code,
    normalize_gtfs_public_stop_code,
)

def build_overpass_query():
    """Build the same OSM selector set used by Dimitar's generator."""

    elements = "".join(
        f'node[{transport_type}=yes][public_transport={public_transport}]'
        f'[ref][network="{OSM_NETWORK_NAME}"];'
        for transport_type, public_transport in OSM_STOP_TYPES
    )
    return (
        "[out:json][timeout:25];"
        f"({elements});"
        "out geom;"
    )


def fetch_osm_stops():
    """Fetch the canonical OSM stop-name map; GTFS is only a per-stop fallback."""

    query = build_overpass_query()
    request = urllib.request.Request(
        OSM_URL,
        data=urlencode({"data": query}).encode("utf-8"),
        headers={
            "User-Agent": OSM_USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as error:
        # Keep the failure explicit. The pipeline may reuse a sufficiently
        # complete previous OSM snapshot, but must never silently turn every
        # stop into GTFS-only data.
        print(f"WARNING: Could not fetch OSM stop names: {error}")
        return None

    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
        print(
            "WARNING: Overpass returned an invalid response"
            + (f": {payload.get('remark')}" if isinstance(payload, dict) and payload.get("remark") else ".")
        )
        return None

    if payload.get("remark"):
        print(f"WARNING: Overpass reported an incomplete response: {payload['remark']}")
        return None

    elements = payload["elements"]

    # Prefer station/stop-position objects over platforms when duplicate
    # public stop codes exist. This ordering is deterministic and independent
    # of the response order returned by Overpass.
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

    named_count = sum(
        bool(normalize(record.get("osm_stop_name")))
        for record in result.values()
    )
    print(
        f"OSM stops with public refs: {len(result)} "
        f"({named_count} with Bulgarian names)"
    )
    return result


def is_usable_osm_snapshot(osm_stops):
    """Reject empty or implausibly small Overpass responses for Sofia."""

    if not isinstance(osm_stops, dict):
        return False

    named_count = sum(
        bool(normalize((record or {}).get("osm_stop_name")))
        for record in osm_stops.values()
        if isinstance(record, dict)
    )
    return (
        len(osm_stops) >= OSM_MIN_STOP_RECORDS
        and named_count >= OSM_MIN_NAMED_STOP_RECORDS
    )


def resolve_osm_snapshot(fetched_osm_stops, previous_osm_stops):
    """Use a complete fresh OSM map, or retain a known-good snapshot.

    Returns (merged_snapshot, refreshed). If neither the current response nor
    the previous snapshot is sufficiently complete, generation is stopped so
    a GTFS-only replacement cannot be published accidentally.
    """

    if is_usable_osm_snapshot(fetched_osm_stops):
        merged = merge_osm_stop_snapshots(
            fetched_osm_stops,
            previous_osm_stops,
        )
        return merged, True

    if is_usable_osm_snapshot(previous_osm_stops):
        print(
            "WARNING: The current OSM response is empty, failed, or incomplete. "
            "Reusing the last known-good OSM snapshot."
        )
        return {
            key: dict(value)
            for key, value in previous_osm_stops.items()
            if isinstance(value, dict)
        }, False

    fetched_count = len(fetched_osm_stops) if isinstance(fetched_osm_stops, dict) else 0
    previous_count = len(previous_osm_stops or {})
    raise RuntimeError(
        "No usable OSM stop-name snapshot is available; refusing to publish "
        "GTFS-only stop names. "
        f"Current OSM records: {fetched_count}; previous OSM records: {previous_count}."
    )


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

        # Store only the canonical public code. Aliasing both stop_id and
        # stop_code can collide (for example metro M314 vs bus stop 0314).
        key = normalize_gtfs_public_stop_code(row)
        if key:
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

        public_code = normalize_gtfs_public_stop_code(row)
        osm = (osm_stops or {}).get(public_code) or {}
        osm_name = normalize(osm.get("osm_stop_name"))

        row.update(osm)
        row["osm_stop_name"] = osm_name
        row["stop_name"] = osm_name or gtfs_name
        row["stop_name_source"] = "osm" if osm_name else "gtfs"

        enriched.append(row)

    return enriched

