"""Orchestrate the download, transformation and modular serialization."""
import shutil

from .config import DATA_DIR, GTFS_DIR, get_today, normalize
from .gtfs import download_gtfs, read_csv
from .osm import (
    fetch_osm_stops, enrich_stops_with_osm,
    load_previous_osm_stops, merge_osm_stop_snapshots,
)
from .calendar import load_calendar_config, build_calendar_context
from .stops import build_stops
from .trips import build_trips, build_stop_times
from .directions import (
    build_reference_directions, merge_partial_directions, merge_logical_trips,
    build_output_directions,
)
from .schedules import build_schedules
from .shapes import load_shapes
from .output import write_transport_data


def load_previous_osm_updated_at():
    """Return the date of the last successful OSM refresh."""
    import json
    metadata_path = DATA_DIR / "metadata.json"
    if not metadata_path.exists():
        return ""
    try:
        with metadata_path.open("r", encoding="utf-8") as file:
            return str(json.load(file).get("osmUpdatedAt") or "")
    except (OSError, ValueError):
        return ""

def main():

    print(
        "=== Sofia GTFS transport generator ==="
    )

    download_gtfs()

    try:

        # --------------------------------------------------------
        # Read GTFS
        # --------------------------------------------------------

        routes_data = read_csv(
            "routes.txt"
        )

        stops_data = read_csv(
            "stops.txt"
        )

        trips_data = read_csv(
            "trips.txt"
        )

        stop_times_data = read_csv(
            "stop_times.txt"
        )

        calendar = (
            read_csv("calendar.txt")
            if (GTFS_DIR / "calendar.txt").exists()
            else []
        )

        calendar_dates = (
            read_csv("calendar_dates.txt")
            if (GTFS_DIR / "calendar_dates.txt").exists()
            else []
        )

        today = get_today()

        print(
            f"Service reference date: {today}"
        )

        # --------------------------------------------------------
        # Active services
        # --------------------------------------------------------

        calendar_config = load_calendar_config()

        (
            service_day_types,
            calendar_result
        ) = build_calendar_context(
            calendar,
            calendar_dates,
            today,
            calendar_config=calendar_config
        )

        # --------------------------------------------------------
        # OSM-first display names with GTFS fallback
        # --------------------------------------------------------

        previous_osm_stops = load_previous_osm_stops()
        fetched_osm_stops = fetch_osm_stops()

        # Keep the last known-good names when Overpass fails or returns only
        # a partial set. A temporary OSM outage must never turn every display
        # name back into the uppercase GTFS variant.
        osm_stops = merge_osm_stop_snapshots(
            fetched_osm_stops,
            previous_osm_stops,
        )
        if fetched_osm_stops is None:
            print(
                "WARNING: Reusing previous OSM stop names because the OSM "
                "request failed."
            )
        elif len(fetched_osm_stops) < len(previous_osm_stops):
            print(
                "WARNING: OSM returned fewer stop records than the previous "
                f"snapshot ({len(fetched_osm_stops)} vs {len(previous_osm_stops)}); "
                "previous names are retained for missing stops."
            )
        print(
            "OSM stop-name records available after merge: "
            f"{len(osm_stops)}"
        )

        stops_data = enrich_stops_with_osm(
            stops_data,
            osm_stops,
        )

        # --------------------------------------------------------
        # GTFS stops
        # --------------------------------------------------------

        output_stops, stops_by_id = (
            build_stops(
                stops_data
            )
        )

        # --------------------------------------------------------
        # Trips
        # --------------------------------------------------------

        trips_by_id = build_trips(
            trips_data,
            service_day_types
        )

        # --------------------------------------------------------
        # Stop times
        # --------------------------------------------------------

        stop_times_by_trip = (
            build_stop_times(
                stop_times_data,
                trips_by_id
            )
        )

        print(
            "Active trips: "
            f"{len(trips_by_id)}"
        )

        print(
            "Trips with stop times: "
            f"{len(stop_times_by_trip)}"
        )

        # --------------------------------------------------------
        # Directions
        # --------------------------------------------------------

        (
            directions,
            logical_trips,
            logical_stop_times
        ) = build_reference_directions(
            trips_by_id,
            stop_times_by_trip
        )

        print(
            "Initial directions: "
            f"{len(directions)}"
        )

        # --------------------------------------------------------
        # Partial directions
        # --------------------------------------------------------

        merge_partial_directions(
            routes_data,
            directions,
            logical_trips,
            logical_stop_times
        )

        print(
            "Directions after partial merge: "
            f"{len(directions)}"
        )

        # --------------------------------------------------------
        # Logical trips
        # --------------------------------------------------------

        merge_logical_trips(
            routes_data,
            logical_trips,
            logical_stop_times
        )

        print(
            "Logical trips after merge: "
            f"{len(logical_trips)}"
        )

        # --------------------------------------------------------
        # Output directions
        # --------------------------------------------------------

        directions_result = (
            build_output_directions(
                routes_data,
                directions,
                logical_trips,
                trips_by_id,
                stop_times_by_trip,
                stops_by_id
            )
        )

        # --------------------------------------------------------
        # Schedules
        # --------------------------------------------------------

        schedules_result = (
            build_schedules(
                directions_result,
                logical_trips,
                logical_stop_times
            )
        )

        # --------------------------------------------------------
        # Shapes
        # --------------------------------------------------------

        selected_shape_ids = set()

        for route_directions in (
            directions_result.values()
        ):

            for direction in (
                route_directions.values()
            ):

                shape_id = normalize(
                    direction.get(
                        "shape_id"
                    )
                )

                if shape_id:

                    selected_shape_ids.add(
                        shape_id
                    )

        shapes_result = load_shapes(
            selected_shape_ids
        )

        # --------------------------------------------------------
        # Final output (written as independently cacheable files)
        # --------------------------------------------------------

        result = {
            "updatedAt": today.isoformat(),
            "source": "CGM Sofia official GTFS",
            "osmSource": "OpenStreetMap — Градски транспорт София",
            "osmUpdatedAt": (
                today.isoformat()
                if fetched_osm_stops is not None and fetched_osm_stops
                else load_previous_osm_updated_at()
            ),
            "calendar": calendar_result,
            "routes": [dict(row) for row in routes_data],
            "stops": output_stops,
            # Keep only fields used by live-board trip matching and route
            # activation. Other GTFS trip metadata was never read by clients.
            "trips": [
                {
                    key: normalize(row.get(key))
                    for key in (
                        "trip_id", "route_id", "service_id",
                        "trip_headsign", "direction_id", "shape_id",
                    )
                }
                for row in trips_data
            ],
            "directions": directions_result,
            "shapes": shapes_result,
            "schedules": schedules_result,
        }

        write_transport_data(result)

        print(
            ""
        )

        print(
            "=== Generation summary ==="
        )

        print(
            "Routes: "
            f"{len(routes_data)}"
        )

        print(
            "Stops: "
            f"{len(output_stops)}"
        )

        print(
            "Directions: "
            f"{sum(len(value) for value in directions_result.values())}"
        )

        print(
            "Schedule routes: "
            f"{len(schedules_result)}"
        )

        print(
            "Shapes: "
            f"{len(shapes_result)}"
        )

        # --------------------------------------------------------
        # Diagnostics
        # --------------------------------------------------------

        print(
            ""
        )

        print(
            "=== Direction diagnostics ==="
        )

        for route in routes_data:

            route_id = normalize(
                route.get(
                    "route_id"
                )
            )

            short_name = normalize(
                route.get(
                    "route_short_name"
                )
            )

            route_directions = (
                directions_result.get(
                    route_id,
                    {}
                )
            )

            if not route_directions:
                continue

            print(
                f"\n{short_name}:"
            )

            for key, direction in (
                route_directions.items()
            ):

                schedule = (
                    schedules_result
                    .get(
                        route_id,
                        {}
                    )
                    .get(
                        key,
                        {}
                    )
                )

                print(
                    "  "
                    f"{key}: "
                    f"{direction['headsign']} | "
                    f"stops={len(direction['stops'])} | "
                    f"weekday={len(schedule.get('weekday', []))} | "
                    f"weekend={len(schedule.get('weekend', []))}"
                )

        print(
            ""
        )

        print(
            f"Modular transport data written to: {DATA_DIR}"
        )

    finally:

        if GTFS_DIR.exists():

            shutil.rmtree(
                GTFS_DIR
            )

        print(
            "Temporary GTFS files removed."
        )

