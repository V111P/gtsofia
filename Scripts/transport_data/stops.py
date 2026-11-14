"""Stop normalization, selection and indexing."""
from .config import normalize, normalize_stop_id

def stop_preference_score(stop):
    """
    Score duplicate GTFS stop records for lookup by stop_id.

    GTFS feeds can contain more than one record with the same stop_id,
    especially when station/parent records are mixed with physical stops.
    For route display we prefer a record that has a real public-facing name
    and code. A physical stop (location_type=0) is preferred as a final
    tie-breaker.
    """

    stop_name = normalize(stop.get("stop_name"))
    stop_code = normalize(stop.get("stop_code"))
    location_type = normalize(stop.get("location_type"))

    return (
        bool(normalize(stop.get("osm_stop_name"))),
        bool(stop_name),
        bool(stop_code),
        location_type == "0",
    )


def build_stop_index(stops):
    """
    Build a stop_id -> stop lookup without letting a later duplicate
    overwrite a better record.
    """

    by_id = {}

    for stop in stops:
        stop_id = normalize(stop.get("stop_id"))

        if not stop_id:
            continue

        current = by_id.get(stop_id)

        if current is None or stop_preference_score(stop) > stop_preference_score(current):
            by_id[stop_id] = stop

    return by_id


def build_stops(
    stops_data
):
    """
    Keep the GTFS stop structure and normalized IDs while preserving the
    OSM-first display name plus the original GTFS name for fallback/search.
    Duplicate stop_ids are retained in the output, but the lookup index
    prefers a named OSM record when choosing the representative row.
    """

    result = []

    for row in stops_data:

        original_id = normalize(
            row.get(
                "stop_id"
            )
        )

        normalized_id = normalize_stop_id(
            original_id
        )

        if not normalized_id:
            continue

        stop = dict(
            row
        )

        stop[
            "stop_id"
        ] = normalized_id

        result.append(
            stop
        )

    return (
        result,
        build_stop_index(result)
    )

