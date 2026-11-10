"""Direction building and consolidation."""
from collections import Counter, defaultdict

from .config import normalize, parse_time

def build_reference_directions(
    trips_by_id,
    stop_times_by_trip
):
    """
    Core direction construction copied from the logic of
    Dimitar5555's 04-schedules.js.

    Every unique ordered stop pattern is a direction.
    """

    directions = []

    route_direction_codes = defaultdict(
        set
    )

    logical_trips = []

    logical_stop_times = []

    for trip_id, trip in (
        trips_by_id.items()
    ):

        trip_stop_times = (
            stop_times_by_trip.get(
                trip_id,
                []
            )
        )

        trip_stops = [
            item[
                "stop_id"
            ]
            for item in
            trip_stop_times
        ]

        if not trip_stops:
            continue

        route_id = trip[
            "route_id"
        ]

        if not route_id:
            continue

        matching_direction = None

        for direction in directions:

            if (
                direction[
                    "code"
                ]
                not in route_direction_codes[
                    route_id
                ]
            ):
                continue

            if (
                len(
                    direction[
                        "stops"
                    ]
                )
                != len(
                    trip_stops
                )
            ):
                continue

            if (
                direction[
                    "stops"
                ]
                == trip_stops
            ):

                matching_direction = (
                    direction
                )

                break

        if matching_direction is None:

            matching_direction = {

                "code":
                    str(
                        len(
                            directions
                        ) + 1
                    ),

                "route_id":
                    route_id,

                "stops":
                    list(
                        trip_stops
                    ),

                "is_deleted":
                    False,

                "trip_ids":
                    [],

                "headsigns":
                    [],

                "shape_ids":
                    [],
            }

            directions.append(
                matching_direction
            )

            route_direction_codes[
                route_id
            ].add(
                matching_direction[
                    "code"
                ]
            )

        direction_code = (
            matching_direction[
                "code"
            ]
        )

        matching_direction[
            "trip_ids"
        ].append(
            trip_id
        )

        if trip[
            "trip_headsign"
        ]:

            matching_direction[
                "headsigns"
            ].append(
                trip[
                    "trip_headsign"
                ]
            )

        if trip[
            "shape_id"
        ]:

            matching_direction[
                "shape_ids"
            ].append(
                trip[
                    "shape_id"
                ]
            )

        matching_trip = None

        for logical_trip in logical_trips:

            if (
                logical_trip[
                    "route_id"
                ]
                != route_id
            ):
                continue

            if (
                logical_trip[
                    "direction_code"
                ]
                != direction_code
            ):
                continue

            if (
                logical_trip.get("day_types", [])
                != trip.get("day_types", [])
            ):
                continue

            matching_trip = (
                logical_trip
            )

            break

        if matching_trip is None:

            matching_trip = {

                "id":
                    len(
                        logical_trips
                    ) + 1,

                "route_id":
                    route_id,

                "direction_code":
                    direction_code,

                "day_types":
                    list(
                        trip.get(
                            "day_types",
                            []
                        )
                    ),

                "original_trip_ids":
                    [],
            }

            logical_trips.append(
                matching_trip
            )

        matching_trip[
            "original_trip_ids"
        ].append(
            trip_id
        )

        times = []

        for stop_time in trip_stop_times:

            parsed = parse_time(
                stop_time.get(
                    "departure_time"
                )
                or stop_time.get(
                    "arrival_time"
                )
            )

            if parsed is None:
                times.append(
                    None
                )
            else:
                times.append(
                    parsed // 60
                )

        logical_stop_times.append({

            "trip":
                matching_trip[
                    "id"
                ],

            "times":
                times,

            # Preserve the GTFS stop_sequence alongside the padded timetable.
            # GTFS-Realtime StopTimeUpdate may identify a stop by sequence
            # instead of stop_id, so the virtual board needs this mapping to
            # decide whether a SKIPPED update applies to the selected stop.
            "stop_sequences": [
                item.get("sequence")
                for item in trip_stop_times
            ],

            "car":
                extract_car_number(
                    trip_id
                ),

            "original_trip_id":
                trip_id,

            # Preserve the exact GTFS service_id of this original trip.
            # Logical trip merging can combine multiple source trips, so the
            # schedule row must retain its own service calendar identity for
            # runtime checks against the actual service date.
            "service_id":
                trip.get(
                    "service_id",
                    ""
                ),
        })

    return (
        directions,
        logical_trips,
        logical_stop_times
    )


def extract_car_number(
    trip_id
):
    parts = trip_id.split(
        "-"
    )

    if trip_id.startswith(
        "M"
    ):

        return (
            parts[2]
            if len(parts) > 2
            else ""
        )

    return (
        parts[-3]
        if len(parts) >= 3
        else ""
    )


def merge_partial_directions(
    routes_data,
    directions,
    logical_trips,
    logical_stop_times
):
    """
    Direct equivalent of the partial-direction merge
    in 04-schedules.js.
    """

    directions_by_code = {
        direction[
            "code"
        ]:
            direction
        for direction in directions
    }

    for route in routes_data:

        route_id = normalize(
            route.get(
                "route_id"
            )
        )

        route_direction_codes = {
            trip[
                "direction_code"
            ]
            for trip in logical_trips
            if (
                trip[
                    "route_id"
                ]
                == route_id
            )
        }

        route_directions = [
            direction
            for direction in directions
            if (
                direction[
                    "code"
                ]
                in route_direction_codes
                and not direction.get(
                    "is_deleted",
                    False
                )
            )
        ]

        route_directions.sort(
            key=lambda direction:
                len(
                    direction[
                        "stops"
                    ]
                ),
            reverse=True
        )

        for index, child in enumerate(
            route_directions
        ):

            if child.get(
                "is_deleted",
                False
            ):
                continue

            child_string = ",".join(
                child[
                    "stops"
                ]
            )

            parent = None

            for parent_index, candidate in enumerate(
                route_directions
            ):

                if (
                    parent_index
                    == index
                ):
                    continue

                if candidate.get(
                    "is_deleted",
                    False
                ):
                    continue

                candidate_string = ",".join(
                    candidate[
                        "stops"
                    ]
                )

                if (
                    child_string
                    in candidate_string
                ):

                    parent = candidate
                    break

            if parent is None:
                continue

            try:

                begin_padding = (
                    parent[
                        "stops"
                    ].index(
                        child[
                            "stops"
                        ][0]
                    )
                )

            except ValueError:
                continue

            end_padding = (
                len(
                    parent[
                        "stops"
                    ]
                )
                - begin_padding
                - len(
                    child[
                        "stops"
                    ]
                )
            )

            child[
                "is_deleted"
            ] = True

            child_code = child[
                "code"
            ]

            for logical_trip in logical_trips:

                if (
                    logical_trip[
                        "direction_code"
                    ]
                    != child_code
                ):
                    continue

                logical_times = [
                    item
                    for item in logical_stop_times
                    if (
                        item[
                            "trip"
                        ]
                        == logical_trip[
                            "id"
                        ]
                    )
                ]

                for item in logical_times:

                    item[
                        "times"
                    ] = (
                        [None]
                        * begin_padding
                        + item[
                            "times"
                        ]
                        + [None]
                        * end_padding
                    )

                    item[
                        "stop_sequences"
                    ] = (
                        [None]
                        * begin_padding
                        + item.get(
                            "stop_sequences",
                            []
                        )
                        + [None]
                        * end_padding
                    )

                logical_trip[
                    "direction_code"
                ] = parent[
                    "code"
                ]

                parent[
                    "trip_ids"
                ] = (
                    parent.get(
                        "trip_ids",
                        []
                    )
                    + child.get(
                        "trip_ids",
                        []
                    )
                )

                parent[
                    "headsigns"
                ] = (
                    parent.get(
                        "headsigns",
                        []
                    )
                    + child.get(
                        "headsigns",
                        []
                    )
                )

                parent[
                    "shape_ids"
                ] = (
                    parent.get(
                        "shape_ids",
                        []
                    )
                    + child.get(
                        "shape_ids",
                        []
                    )
                )

        for i in range(
            len(directions) - 1,
            -1,
            -1
        ):

            direction = directions[
                i
            ]

            if not direction.get(
                "is_deleted",
                False
            ):
                continue

            code = direction[
                "code"
            ]

            orphan_trips = any(
                trip[
                    "direction_code"
                ]
                == code
                for trip in logical_trips
            )

            if not orphan_trips:

                directions.pop(
                    i
                )

                directions_by_code.pop(
                    code,
                    None
                )


def merge_logical_trips(
    routes_data,
    logical_trips,
    logical_stop_times
):
    """
    Direct equivalent of the trip merge in 04-schedules.js.
    """

    for route in routes_data:

        route_id = normalize(
            route.get(
                "route_id"
            )
        )

        route_trips = [
            trip
            for trip in logical_trips
            if trip[
                "route_id"
            ] == route_id
        ]

        for index, trip in enumerate(
            route_trips
        ):

            same = None

            for candidate_index, candidate in enumerate(
                route_trips
            ):

                if (
                    candidate_index
                    == index
                ):
                    continue

                if (
                    candidate[
                        "direction_code"
                    ]
                    != trip[
                        "direction_code"
                    ]
                ):
                    continue

                if (
                    candidate.get("day_types", [])
                    != trip.get("day_types", [])
                ):
                    continue

                if candidate.get(
                    "is_deleted",
                    False
                ):
                    continue

                same = candidate
                break

            if same is None:
                continue

            for item in logical_stop_times:

                if (
                    item[
                        "trip"
                    ]
                    == trip[
                        "id"
                    ]
                ):

                    item[
                        "trip"
                    ] = same[
                        "id"
                    ]

            same[
                "original_trip_ids"
            ] = (
                same[
                    "original_trip_ids"
                ]
                + trip[
                    "original_trip_ids"
                ]
            )

            trip[
                "is_deleted"
            ] = True

        for i in range(
            len(logical_trips) - 1,
            -1,
            -1
        ):

            trip = logical_trips[
                i
            ]

            if not trip.get(
                "is_deleted",
                False
            ):
                continue

            trip_id = trip[
                "id"
            ]

            has_orphan_stop_times = any(
                item[
                    "trip"
                ]
                == trip_id
                for item in logical_stop_times
            )

            if not has_orphan_stop_times:
                logical_trips.pop(
                    i
                )


def choose_direction_name(
    direction,
    stops_by_id
):
    """Prefer the OSM name of the terminal stop, then fall back to GTFS."""

    stops = direction.get("stops", [])
    terminal_stop = (
        stops_by_id.get(stops[-1])
        if stops
        else None
    )

    if terminal_stop:
        osm_name = normalize(terminal_stop.get("osm_stop_name"))
        if osm_name:
            return osm_name

    headsigns = [
        normalize(value)
        for value in direction.get("headsigns", [])
        if normalize(value)
    ]

    if headsigns:
        return Counter(headsigns).most_common(1)[0][0]

    if terminal_stop:
        return normalize(
            terminal_stop.get("stop_name")
            or terminal_stop.get("gtfs_stop_name")
        )

    return ""


def choose_shape_id(
    direction
):
    shapes = [
        normalize(value)
        for value in direction.get(
            "shape_ids",
            []
        )
        if normalize(value)
    ]

    if not shapes:
        return ""

    return Counter(
        shapes
    ).most_common(
        1
    )[0][0]


def build_output_directions(
    routes_data,
    directions,
    logical_trips,
    trips_by_id,
    stop_times_by_trip,
    stops_by_id
):
    """
    Output ALL surviving directions.

    No A/B restriction.
    """

    result = {}

    directions_by_code = {
        direction[
            "code"
        ]:
            direction
        for direction in directions
    }

    for route in routes_data:

        route_id = normalize(
            route.get(
                "route_id"
            )
        )

        route_trips = [
            trip
            for trip in logical_trips
            if (
                trip[
                    "route_id"
                ]
                == route_id
                and not trip.get(
                    "is_deleted",
                    False
                )
            )
        ]

        if not route_trips:
            continue

        direction_codes = []

        for trip in route_trips:

            code = trip[
                "direction_code"
            ]

            if code not in direction_codes:

                direction_codes.append(
                    code
                )

        route_directions = {}

        for ordinal, code in enumerate(
            direction_codes,
            start=1
        ):

            direction = directions_by_code.get(
                code
            )

            if direction is None:
                continue

            stop_records = []

            for stop_id in direction[
                "stops"
            ]:

                stop = stops_by_id.get(
                    stop_id
                )

                if stop is None:
                    continue

                stop_records.append({
                    "stop_id": normalize(stop.get("stop_id")),
                    "name": normalize(stop.get("stop_name")),
                    "osm_name": normalize(stop.get("osm_stop_name")),
                    "gtfs_name": normalize(
                        stop.get("gtfs_stop_name")
                        or stop.get("stop_name")
                    ),
                })

            if not stop_records:
                continue

            direction_trips = [
                trip
                for trip in route_trips
                if trip[
                    "direction_code"
                ]
                == code
            ]

            representative = None

            if direction_trips:

                representative_id = (
                    direction_trips[
                        0
                    ].get(
                        "original_trip_ids",
                        []
                    )[0]
                    if direction_trips[
                        0
                    ].get(
                        "original_trip_ids"
                    )
                    else ""
                )

                if representative_id:

                    representative = (
                        trips_by_id.get(
                            representative_id
                        )
                    )

            direction_key = (
                f"D{ordinal}"
            )

            direction_name = (
                choose_direction_name(
                    direction,
                    stops_by_id
                )
            )

            route_directions[
                direction_key
            ] = {

                "key":
                    direction_key,

                "code":
                    code,

                "headsign":
                    direction_name,

                "destination":
                    direction_name,

                "trip_id":
                    (
                        representative[
                            "trip_id"
                        ]
                        if representative
                        else ""
                    ),

                "direction_id":
                    (
                        representative[
                            "direction_id"
                        ]
                        if representative
                        else ""
                    ),

                "shape_id":
                    choose_shape_id(
                        direction
                    ),

                "service_id":
                    (
                        representative[
                            "service_id"
                        ]
                        if representative
                        else ""
                    ),

                "frequency":
                    len(
                        direction_trips
                    ),

                "stop_count":
                    len(
                        stop_records
                    ),

                "stops":
                    stop_records,

                "pattern":
                    [
                        stop[
                            "stop_id"
                        ]
                        for stop in stop_records
                    ]
            }

        if route_directions:

            result[
                route_id
            ] = route_directions

    return result

