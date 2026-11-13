"""Write generated transport data as independently cacheable JSON files."""
import json
from collections import Counter
from datetime import date
from pathlib import Path

from .config import DATA_DIR, LEGACY_OUTPUT_FILE


def _write_json_atomic(path: Path, value):
    temporary_path = path.with_name(path.name + ".tmp")
    with temporary_path.open("w", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, separators=(",", ":"))
    temporary_path.replace(path)


def build_trip_destinations(directions, schedules, routes=None):
    """Map each surface-transport GTFS trip to its OSM-first terminal stop."""
    result = {}
    metro_route_ids = {
        str(route.get("route_id") or "").strip()
        for route in (routes or [])
        if str(route.get("route_type") or "").strip() == "1"
    }

    for route_id, route_schedule in (schedules or {}).items():
        if route_id in metro_route_ids:
            continue
        route_directions = (directions or {}).get(route_id, {})
        for direction_key, day_types in route_schedule.items():
            direction = route_directions.get(direction_key, {})
            stops = direction.get("stops") or []
            if not stops:
                continue

            terminal = stops[-1]
            terminal_stop_id = str(terminal.get("stop_id") or "").strip()
            destination = str(
                terminal.get("osm_name")
                or terminal.get("osm_stop_name")
                or terminal.get("name")
                or terminal.get("gtfs_name")
                or direction.get("destination")
                or direction.get("headsign")
                or ""
            ).strip()
            if not terminal_stop_id or not destination:
                continue

            metadata = {
                "terminal_stop_id": terminal_stop_id,
                "destination": destination,
            }

            for rows in (day_types or {}).values():
                for row in rows or []:
                    trip_id = str(row.get("original_trip_id") or "").strip()
                    if not trip_id:
                        continue
                    previous = result.get(trip_id)
                    if previous and previous != metadata:
                        raise ValueError(
                            f"GTFS trip {trip_id} maps to multiple directions: "
                            f"{previous!r} and {metadata!r}"
                        )
                    result[trip_id] = metadata

    return result


def build_metro_board_data(routes, directions, schedules, calendar):
    """Build a compact, metro-only timetable dataset for virtual boards.

    Metro has no usable RT arrival feed in this integration. Its virtual-board
    rows are therefore explicitly scheduled, while surface modes remain RT-only.
    """
    routes_by_id = {
        str(route.get("route_id") or "").strip(): route
        for route in (routes or [])
        if str(route.get("route_type") or "").strip() == "1"
    }
    metro_routes = {}

    for route_id, route_schedule in (schedules or {}).items():
        route = routes_by_id.get(route_id)
        if not route:
            continue

        direction_data = (directions or {}).get(route_id, {})
        route_directions = {}
        for direction_key, day_types in route_schedule.items():
            direction = direction_data.get(direction_key, {})
            stops = direction.get("stops") or []
            if not stops:
                continue

            stop_ids = [
                str(stop.get("stop_id") or "").strip()
                for stop in stops
            ]
            if not any(stop_ids):
                continue

            terminal = stops[-1]
            destination = str(
                terminal.get("osm_name")
                or terminal.get("osm_stop_name")
                or terminal.get("name")
                or terminal.get("gtfs_name")
                or direction.get("destination")
                or direction.get("headsign")
                or ""
            ).strip()

            directions_out = {
                "destination": destination,
                "terminal_stop_id": str(terminal.get("stop_id") or "").strip(),
                "stop_ids": stop_ids,
                "weekday": [],
                "weekend": [],
            }

            for day_type in ("weekday", "weekend"):
                for row in (day_types or {}).get(day_type, []) or []:
                    times = row.get("times")
                    if not isinstance(times, list):
                        continue
                    directions_out[day_type].append({"times": times})

            if directions_out["weekday"] or directions_out["weekend"]:
                route_directions[direction_key] = directions_out

        if route_directions:
            metro_routes[route_id] = {
                "route_id": route_id,
                "route_short_name": str(route.get("route_short_name") or "").strip(),
                "route_type": str(route.get("route_type") or "1").strip(),
                "route_color": str(route.get("route_color") or "").strip(),
                "route_text_color": str(route.get("route_text_color") or "").strip(),
                "directions": route_directions,
            }

    source_calendar = calendar or {}
    date_overrides = (source_calendar.get("config") or {}).get("dateOverrides") or {}
    date_types = dict(source_calendar.get("dateTypes") or {})
    service_ids_by_date = source_calendar.get("serviceIdsByDate") or {}
    service_day_types = source_calendar.get("serviceDayTypes") or {}

    # The general schedules page only needs an explicit 15-day date window.
    # Virtual metro boards need the full published service range, including
    # weekdays that operate on a holiday/weekend timetable. Derive those dates
    # from the active GTFS service IDs rather than assuming every Monday-Friday
    # uses a weekday timetable.
    for date_key, service_ids in service_ids_by_date.items():
        if date_key in date_overrides:
            date_types[date_key] = date_overrides[date_key]
            continue
        if date_key in date_types:
            continue

        counts = Counter(
            day_type
            for service_id in service_ids or []
            for day_type in service_day_types.get(str(service_id), [])
            if day_type in {"weekday", "weekend"}
        )
        if counts["weekday"] > counts["weekend"]:
            date_types[date_key] = "weekday"
        elif counts["weekend"] > counts["weekday"]:
            date_types[date_key] = "weekend"
        else:
            weekday = date.fromisoformat(date_key).weekday()
            date_types[date_key] = "weekend" if weekday >= 5 else "weekday"

    calendar_data = {
        "dateTypes": date_types,
        "dateOverrides": date_overrides,
    }
    return {"calendar": calendar_data, "routes": metro_routes}



def build_virtual_board_schedule_data(routes, stops, directions, schedules, calendar):
    """Build the compact surface-transport schedule index consumed by Render.

    The proxy needs a stop-indexed timetable, not the full site schedule model.
    Calendar service dates are encoded as per-service bitsets to avoid copying
    the multi-megabyte serviceIdsByDate index into the Render service.
    """
    from datetime import date

    routes_by_id = {
        str(route.get("route_id") or "").strip(): route
        for route in (routes or [])
    }
    metro_route_ids = {
        route_id
        for route_id, route in routes_by_id.items()
        if str(route.get("route_type") or "").strip() == "1"
    }

    service_ids = set()
    for route_id, route_directions in (schedules or {}).items():
        if route_id in metro_route_ids:
            continue
        for day_types in (route_directions or {}).values():
            for day_type in ("weekday", "weekend"):
                for row in (day_types or {}).get(day_type, []) or []:
                    service_id = str(row.get("service_id") or "").strip()
                    if service_id:
                        service_ids.add(service_id)

    source_calendar = calendar or {}
    reference_date = str(source_calendar.get("referenceDate") or "").strip()
    coverage_end = str(source_calendar.get("serviceCoverageEndDate") or reference_date).strip()
    try:
        reference = date.fromisoformat(reference_date)
        end = date.fromisoformat(coverage_end)
    except ValueError as error:
        raise ValueError("Proxy schedule calendar has invalid coverage dates.") from error

    coverage_days = (end - reference).days + 1
    if coverage_days <= 0 or coverage_days > 800:
        raise ValueError(f"Proxy schedule calendar coverage is invalid: {coverage_days} days.")

    service_bits = {service_id: 0 for service_id in service_ids}
    service_ids_by_date = source_calendar.get("serviceIdsByDate") or {}
    for date_key, active_services in service_ids_by_date.items():
        try:
            offset = (date.fromisoformat(date_key) - reference).days
        except ValueError:
            continue
        if offset < 0 or offset >= coverage_days:
            continue
        bit = 1 << offset
        for service_id in active_services or []:
            service_id = str(service_id).strip()
            if service_id in service_bits:
                service_bits[service_id] |= bit

    stop_ids_by_identifier = {}
    for stop in (stops or []):
        stop_id = str(stop.get("stop_id") or "").strip()
        stop_code = str(stop.get("stop_code") or "").strip()
        if not stop_id:
            continue
        for identifier in {stop_id, stop_code} - {""}:
            stop_ids_by_identifier.setdefault(identifier, set()).add(stop_id)

    routes_out = {}
    for route_id, route_schedule in (schedules or {}).items():
        if route_id in metro_route_ids:
            continue
        route = routes_by_id.get(route_id)
        if not route:
            continue

        route_directions_out = {}
        for direction_key, day_types in (route_schedule or {}).items():
            direction = (directions or {}).get(route_id, {}).get(direction_key, {})
            direction_stops = direction.get("stops") or []
            stop_ids = [str(stop.get("stop_id") or "").strip() for stop in direction_stops]
            if not stop_ids or not any(stop_ids):
                continue

            terminal = direction_stops[-1]
            terminal_stop_id = str(terminal.get("stop_id") or "").strip()
            destination = str(
                terminal.get("osm_name")
                or terminal.get("osm_stop_name")
                or terminal.get("name")
                or terminal.get("gtfs_name")
                or direction.get("destination")
                or direction.get("headsign")
                or ""
            ).strip()

            courses_by_trip = {}
            for day_type in ("weekday", "weekend"):
                for row in (day_types or {}).get(day_type, []) or []:
                    trip_id = str(row.get("original_trip_id") or "").strip()
                    service_id = str(row.get("service_id") or "").strip()
                    times = row.get("times")
                    if not trip_id or not service_id or not isinstance(times, list):
                        continue
                    course = {
                        "tripId": trip_id,
                        "serviceId": service_id,
                        "times": list(times[:len(stop_ids)]),
                    }
                    previous = courses_by_trip.get(trip_id)
                    if previous is not None and previous != course:
                        raise ValueError(
                            f"GTFS trip {trip_id} has conflicting timetable rows in {route_id}/{direction_key}."
                        )
                    courses_by_trip[trip_id] = course

            if not courses_by_trip:
                continue

            route_directions_out[str(direction_key)] = {
                "headsign": str(direction.get("headsign") or direction.get("destination") or "").strip(),
                "destination": destination,
                "terminalStopId": terminal_stop_id,
                "stopIds": stop_ids,
                "courses": list(courses_by_trip.values()),
            }

        if route_directions_out:
            routes_out[route_id] = {
                "routeId": route_id,
                "routeShortName": str(route.get("route_short_name") or route.get("route_long_name") or route_id).strip(),
                "routeType": str(route.get("route_type") or "").strip(),
                "routeColor": str(route.get("route_color") or "").strip(),
                "routeTextColor": str(route.get("route_text_color") or "").strip(),
                "directions": route_directions_out,
            }

    return {
        "schemaVersion": 1,
        "generatedAt": reference_date,
        "calendar": {
            "referenceDate": reference_date,
            "coverageEndDate": coverage_end,
            "coverageDays": coverage_days,
            "serviceBits": {service_id: format(bits, "x") for service_id, bits in service_bits.items()},
        },
        "stopIdsByIdentifier": {
            identifier: sorted(stop_ids)
            for identifier, stop_ids in stop_ids_by_identifier.items()
        },
        "routes": routes_out,
    }

def write_transport_data(result):
    """Split the in-memory model into files consumed by GTSofia's frontend."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    trip_destinations = build_trip_destinations(
        result["directions"], result["schedules"], result["routes"]
    )
    metro_board = build_metro_board_data(
        result["routes"],
        result["directions"],
        result["schedules"],
        result["calendar"],
    )

    files = {
        "metadata.json": {
            "schemaVersion": 2,
            "updatedAt": result["updatedAt"],
            "source": result["source"],
            "osmSource": result["osmSource"],
            "osmUpdatedAt": result["osmUpdatedAt"],
        },
        "calendar.json": result["calendar"],
        "routes.json": result["routes"],
        "stops.json": result["stops"],
        "trips.json": result["trips"],
        "directions.json": result["directions"],
        "shapes.json": result["shapes"],
        "schedules.json": result["schedules"],
        "trip-destinations.json": trip_destinations,
        "metro-board.json": metro_board,
    }

    for filename, value in files.items():
        _write_json_atomic(DATA_DIR / filename, value)

    # Render runs from realtime-proxy/ as its root directory, so keep an
    # independently generated, compact surface-timetable index inside that
    # deployment root. The metro remains on its existing local timetable path.
    proxy_data_dir = DATA_DIR.parent / "realtime-proxy" / "data"
    proxy_data_dir.mkdir(parents=True, exist_ok=True)
    proxy_schedule_data = build_virtual_board_schedule_data(
        result["routes"], result["stops"], result["directions"],
        result["schedules"], result["calendar"],
    )
    proxy_schedule_path = proxy_data_dir / "virtual-board-schedules.json"
    _write_json_atomic(proxy_schedule_path, proxy_schedule_data)
    print(
        "  realtime-proxy/data/virtual-board-schedules.json "
        f"({proxy_schedule_path.stat().st_size / 1024 / 1024:.2f} MiB)"
    )

    # Do not leave the obsolete monolithic file in the published site/repo.
    if LEGACY_OUTPUT_FILE.exists():
        LEGACY_OUTPUT_FILE.unlink()

    print("Written modular data files:")
    for filename in files:
        path = DATA_DIR / filename
        print(f"  {path.relative_to(DATA_DIR.parent)} ({path.stat().st_size / 1024 / 1024:.2f} MiB)")
