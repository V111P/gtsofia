"""Schedule serialization grouped by route, direction and day type."""
from .config import normalize, parse_time

def build_schedules(
    directions_result,
    logical_trips,
    logical_stop_times
):
    """
    Schedules use the SAME D1/D2/... direction keys as directions.
    """

    schedules = {}

    for route_id, route_directions in (
        directions_result.items()
    ):

        route_schedule = {}

        for key, direction in (
            route_directions.items()
        ):

            code = direction[
                "code"
            ]

            weekday = []
            weekend = []

            matching_trips = [
                trip
                for trip in logical_trips
                if (
                    trip[
                        "route_id"
                    ]
                    == route_id
                    and trip[
                        "direction_code"
                    ]
                    == code
                    and not trip.get(
                        "is_deleted",
                        False
                    )
                )
            ]

            for logical_trip in matching_trips:

                trip_day_types = logical_trip.get(
                    "day_types",
                    []
                )

                if not trip_day_types:
                    trip_day_types = [
                        "weekend"
                        if logical_trip.get(
                            "is_weekend",
                            False
                        )
                        else "weekday"
                    ]

                trip_times = [
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

                for item in trip_times:

                    values = item.get(
                        "times",
                        []
                    )

                    if not values:
                        continue

                    non_null = [
                        value
                        for value in values
                        if value is not None
                    ]

                    if not non_null:
                        continue

                    first = non_null[
                        0
                    ]

                    schedule_row = {

                        "trip_id":
                            logical_trip[
                                "id"
                            ],

                        # Keep the original GTFS trip id on every schedule
                        # row. GTFS-Realtime references this original id,
                        # while the public schedule uses the logical trip id
                        # created by the generator. This lets the virtual board
                        # suppress a SKIPPED course exactly, without hiding
                        # later courses in the same direction.
                        "original_trip_id":
                            normalize(
                                item.get(
                                    "original_trip_id",
                                    ""
                                )
                            ),

                        "service_id":
                            normalize(
                                item.get(
                                    "service_id",
                                    ""
                                )
                            ),

                        "stop_sequences":
                            [
                                sequence
                                if sequence is None
                                else int(sequence)
                                for sequence in item.get(
                                    "stop_sequences",
                                    []
                                )
                            ],

                        "start_time":
                            (
                                f"{first // 60:02d}:"
                                f"{first % 60:02d}:00"
                            ),

                        "times":
                            [
                                (
                                    f"{value // 60:02d}:"
                                    f"{value % 60:02d}:00"
                                )
                                if value is not None
                                else None
                                for value in values
                            ],

                        "car":
                            item.get(
                                "car",
                                ""
                            )
                    }

                    if "weekday" in trip_day_types:
                        weekday.append(dict(schedule_row))

                    if "weekend" in trip_day_types:
                        weekend.append(dict(schedule_row))

            weekday.sort(
                key=lambda item:
                    parse_time(
                        item[
                            "start_time"
                        ]
                    )
                    if parse_time(
                        item[
                            "start_time"
                        ]
                    ) is not None
                    else 10**12
            )

            weekend.sort(
                key=lambda item:
                    parse_time(
                        item[
                            "start_time"
                        ]
                    )
                    if parse_time(
                        item[
                            "start_time"
                        ]
                    ) is not None
                    else 10**12
            )

            route_schedule[
                key
            ] = {

                "weekday":
                    weekday,

                "weekend":
                    weekend
            }

        if route_schedule:

            schedules[
                route_id
            ] = route_schedule

    return schedules

