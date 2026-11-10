#!/usr/bin/env python3
"""Backward-compatible entry point for the modular GTSofia data generator."""
from pathlib import Path
import sys

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from transport_data.config import (  # noqa: F401
    GTFS_URL, OSM_URL, OSM_NETWORK_NAME, OSM_STOP_TYPES, ROOT, DATA_DIR,
    GTFS_DIR, LEGACY_OUTPUT_FILE, CALENDAR_CONFIG_FILE,
    SOFIA_TIME_ZONE, GTFS_WEEKDAY_FIELDS,
    normalize, normalize_stop_id, normalize_osm_stop_code,
    parse_date, parse_time, get_today, gtfs_date_string, iso_date_string,
)
from transport_data.gtfs import download_gtfs, read_csv  # noqa: F401
from transport_data.osm import (  # noqa: F401
    fetch_osm_stops, enrich_stops_with_osm,
    previous_osm_stops_from_rows, merge_osm_stop_snapshots,
)
from transport_data.calendar import (  # noqa: F401
    _calendar_row_covers_date, _apply_calendar_date_exceptions,
    load_calendar_config, build_calendar_context,
)
from transport_data.stops import (  # noqa: F401
    stop_preference_score, build_stop_index, build_stops,
)
from transport_data.trips import build_trips, build_stop_times  # noqa: F401
from transport_data.directions import (  # noqa: F401
    build_reference_directions, extract_car_number, merge_partial_directions,
    merge_logical_trips, choose_direction_name, choose_shape_id,
    build_output_directions,
)
from transport_data.schedules import build_schedules  # noqa: F401
from transport_data.shapes import load_shapes  # noqa: F401
from transport_data.output import write_transport_data  # noqa: F401
from transport_data.pipeline import main


if __name__ == "__main__":
    main()
