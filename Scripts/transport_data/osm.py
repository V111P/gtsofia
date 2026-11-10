"""OpenStreetMap stop-name enrichment."""
import json
import urllib.request
from urllib.parse import urlencode

from .config import (
    OSM_URL, OSM_FALLBACK_URLS, OSM_NETWORK_NAME, OSM_STOP_FILTERS,
    OSM_MIN_NAMED_STOPS, DATA_DIR,
    normalize, normalize_osm_stop_code, normalize_stop_id,
)


def build_osm_stop_query():
    """Build a query covering the node/way/relation forms used for OSM stops."""

    elements = "".join(
        f'nwr[{mode_key}="{mode_value}"]'
        f'[{feature_key}="{feature_value}"][ref]'
        f'[network="{OSM_NETWORK_NAME}"];'
        for mode_key, mode_value, feature_key, feature_value in OSM_STOP_FILTERS
    )
    return (
        "[out:json][timeout:50];"
        f"({elements});"
        # Ways and relations need center coordinates; all tags are retained.
        "out center tags;"
    )


def _parse_osm_stop_elements(elements):
    """Convert raw Overpass elements into the public-stop-code lookup."""

    # When multiple OSM objects share a public code, the platform is the most
    # passenger-facing record. It is processed last and therefore wins.
    priority = {
        "station": 0,
        "stop_position": 1,
        "platform": 2,
    }
    elements = sorted(
        elements,
        key=lambda element: priority.get(
            normalize((element.get("tags") or {}).get("public_transport")),
            99,
        ),
    )

    result = {}
    for element in elements:
        tags = element.get("tags") or {}
        code = normalize_osm_stop_code(tags)
        if not code:
            continue

        # A present-but-whitespace-only `name` must not mask `name:bg`.
        name = normalize(tags.get("name")) or normalize(tags.get("name:bg"))
        result[code] = {
            "osm_stop_name": name,
            "osm_stop_name_en": normalize(tags.get("name:en")),
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

    return result


def fetch_osm_stops():
    """Fetch public stop names from Overpass, retrying independent mirrors.

    ``None`` means every endpoint failed or returned an incomplete response.
    The pipeline treats that differently from a valid snapshot and refuses to
    publish GTFS-only names when no known-good OSM snapshot exists.
    """

    query = build_osm_stop_query()
    endpoints = tuple(dict.fromkeys((OSM_URL, *OSM_FALLBACK_URLS)))
    errors = []

    for endpoint in endpoints:
        request = urllib.request.Request(
            endpoint,
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

            raw_elements = payload.get("elements")
            if not isinstance(raw_elements, list):
                raise ValueError("Overpass response has no elements array")

            result = _parse_osm_stop_elements(raw_elements)
            named_count = sum(
                bool(normalize(record.get("osm_stop_name")))
                for record in result.values()
            )
            if named_count < OSM_MIN_NAMED_STOPS:
                raise ValueError(
                    "Overpass returned an incomplete stop snapshot "
                    f"({named_count} named records; expected at least "
                    f"{OSM_MIN_NAMED_STOPS})"
                )

            print(
                f"OSM stop-name records fetched from {endpoint}: "
                f"{len(result)} ({named_count} named)"
            )
            return result
        except Exception as error:
            errors.append(f"{endpoint}: {error}")
            print(f"WARNING: OSM request failed at {endpoint}: {error}")

    print("WARNING: All Overpass endpoints failed: " + " | ".join(errors))
    return None



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
        # Older snapshots stored the selected OSM name only in stop_name.
        if not osm_name and row.get("stop_name_source") == "osm":
            osm_name = normalize(row.get("stop_name"))
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


def resolve_osm_stop_snapshot(current_osm_stops, previous_osm_stops):
    """Accept only complete OSM snapshots and fail closed on data loss.

    A partial response is not merged into published data: doing so would let
    missing records fall back to GTFS. Reuse a complete previous snapshot, or
    abort generation before outputs are written when neither snapshot is good.

    Returns ``(selected_snapshot, accepted_fresh_snapshot)``. The second item
    is ``None`` when a previous snapshot had to be reused.
    """

    def named_count(records):
        return sum(
            bool(normalize(value.get("osm_stop_name")))
            for value in (records or {}).values()
            if isinstance(value, dict)
        )

    fresh_count = named_count(current_osm_stops)
    previous_count = named_count(previous_osm_stops)

    if current_osm_stops is not None and fresh_count >= OSM_MIN_NAMED_STOPS:
        return (
            merge_osm_stop_snapshots(current_osm_stops, previous_osm_stops),
            current_osm_stops,
        )

    if previous_count >= OSM_MIN_NAMED_STOPS:
        print(
            "WARNING: Keeping the previous OSM snapshot; the new response "
            f"contains only {fresh_count} named records."
        )
        return {
            key: dict(value)
            for key, value in (previous_osm_stops or {}).items()
            if isinstance(value, dict)
        }, None

    raise RuntimeError(
        "No complete OSM stop-name snapshot is available. "
        f"Fresh response: {fresh_count} named records; previous snapshot: "
        f"{previous_count}; minimum required: {OSM_MIN_NAMED_STOPS}. "
        "Refusing to publish GTFS-only stop names."
    )


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

