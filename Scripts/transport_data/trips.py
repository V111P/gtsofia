"""Active-trip filtering and stop-time indexing."""
from collections import defaultdict

from .config import normalize, normalize_stop_id

def build_trips(
    trips_data,
    service_day_types
):
    trips_by_id = {}

    for row in trips_data:

        trip_id = normalize(
            row.get(
                "trip_id"
            )
        )

        if not trip_id:
            continue

        service_id = normalize(
            row.get(
                "service_id"
            )
        )

        day_types = list(
            service_day_types.get(
                service_id,
                []
            )
        )

        if not day_types:
            continue

        trips_by_id[
            trip_id
        ] = {

            "trip_id":
                trip_id,

            "route_id":
                normalize(
                    row.get(
                        "route_id"
                    )
                ),

            "service_id":
                service_id,

            "trip_headsign":
                normalize(
                    row.get(
                        "trip_headsign"
                    )
                ),

            "direction_id":
                normalize(
                    row.get(
                        "direction_id"
                    )
                ),

            "shape_id":
                normalize(
                    row.get(
                        "shape_id"
                    )
                ),

            "day_types":
                day_types,

            # Kept for compatibility with older internal data consumers.
            "is_weekend":
                day_types == ["weekend"],
        }

    return trips_by_id


def build_stop_times(
    stop_times_data,
    trips_by_id
):
    result = defaultdict(list)

    for row in stop_times_data:

        trip_id = normalize(
            row.get(
                "trip_id"
            )
        )

        if trip_id not in trips_by_id:
            continue

        stop_id = normalize_stop_id(
            row.get(
                "stop_id"
            )
        )

        if not stop_id:
            continue

        try:

            sequence = int(
                row.get(
                    "stop_sequence",
                    0
                )
            )

        except (
            TypeError,
            ValueError
        ):

            sequence = 0

        result[
            trip_id
        ].append({

            "stop_id":
                stop_id,

            "sequence":
                sequence,

            "arrival_time":
                normalize(
                    row.get(
                        "arrival_time"
                    )
                ),

            "departure_time":
                normalize(
                    row.get(
                        "departure_time"
                    )
                ),
        })

    for trip_id in result:

        result[
            trip_id
        ].sort(
            key=lambda item:
                item[
                    "sequence"
                ]
        )

    return result

