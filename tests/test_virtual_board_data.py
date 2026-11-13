import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "Scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from transport_data.output import build_metro_board_data, build_trip_destinations


class VirtualBoardOutputTests(unittest.TestCase):
    def setUp(self):
        self.directions = {
            "TM22": {
                "D1": {
                    "destination": "Остаро име",
                    "stops": [
                        {"stop_id": "0633", "name": "Начална"},
                        {"stop_id": "2023", "name": "Автостанция Изток", "osm_name": "Автостанция Изток"},
                    ],
                }
            },
            "M1": {
                "D1": {
                    "destination": "Бизнес парк София",
                    "stops": [
                        {"stop_id": "M1", "name": "Сливница", "osm_name": "Сливница"},
                        {"stop_id": "M16", "name": "Бизнес парк София", "osm_name": "Бизнес парк София"},
                    ],
                }
            },
        }
        self.schedules = {
            "TM22": {
                "D1": {
                    "weekday": [{"original_trip_id": "tram-trip", "times": ["05:00:00", "05:10:00"]}],
                    "weekend": [{"original_trip_id": "tram-trip", "times": ["06:00:00", "06:10:00"]}],
                }
            },
            "M1": {
                "D1": {
                    "weekday": [{"original_trip_id": "metro-trip", "times": ["05:00:00", "05:30:00"]}],
                    "weekend": [{"original_trip_id": "metro-trip-weekend", "times": ["06:00:00", "06:30:00"]}],
                }
            },
        }
        self.routes = [
            {"route_id": "TM22", "route_short_name": "22", "route_type": "0", "route_color": "F7941D"},
            {"route_id": "M1", "route_short_name": "1", "route_type": "1", "route_color": "1C75BC"},
        ]
        self.calendar = {
            "dateTypes": {"2026-11-13": "weekday"},
            "serviceIdsByDate": {
                "2026-11-13": ["weekday-service"],
                "2026-12-24": ["holiday-service"],
                "2026-12-25": ["weekend-service"],
                "2026-12-26": ["weekday-service", "weekend-service"],
            },
            "serviceDayTypes": {
                "weekday-service": ["weekday"],
                "holiday-service": ["weekend"],
                "weekend-service": ["weekend"],
            },
            "config": {"dateOverrides": {"2026-11-14": "weekend", "2026-12-24": "weekday"}},
            "serviceCoverageEndDate": "2027-11-13",
        }

    def test_trip_destination_uses_osm_first_terminal_stop(self):
        result = build_trip_destinations(self.directions, self.schedules, self.routes)
        self.assertEqual(result["tram-trip"]["terminal_stop_id"], "2023")
        self.assertEqual(result["tram-trip"]["destination"], "Автостанция Изток")
        self.assertNotIn("metro-trip", result, "metro uses its own compact timetable dataset")
        self.assertNotIn("route_id", result["tram-trip"], "route ID is already supplied by the RT event")

    def test_partial_course_uses_its_own_terminal_stop(self):
        directions = {
            "TM22": {
                "D1": {
                    "stops": [
                        {"stop_id": "0633", "osm_name": "Начална"},
                        {"stop_id": "1247", "osm_name": "Парк Св. Св. Петър и Павел"},
                        {"stop_id": "2023", "osm_name": "Автостанция Изток"},
                    ]
                },
                "D2": {
                    "stops": [
                        {"stop_id": "0633", "osm_name": "Начална"},
                        {"stop_id": "1247", "osm_name": "Парк Св. Св. Петър и Павел"},
                        {"stop_id": "0470", "osm_name": "гара Подуяне"},
                    ]
                },
            }
        }
        schedules = {
            "TM22": {
                "D1": {"weekday": [{"original_trip_id": "full-course"}]},
                "D2": {"weekday": [{"original_trip_id": "partial-course"}]},
            }
        }

        result = build_trip_destinations(directions, schedules, self.routes)
        self.assertEqual(result["full-course"]["terminal_stop_id"], "2023")
        self.assertEqual(result["partial-course"]["terminal_stop_id"], "0470")
        self.assertEqual(result["partial-course"]["destination"], "гара Подуяне")

    def test_conflicting_direction_for_same_original_trip_is_rejected(self):
        schedules = {
            "TM22": {
                "D1": {"weekday": [{"original_trip_id": "same-trip"}]},
                "D2": {"weekday": [{"original_trip_id": "same-trip"}]},
            }
        }
        directions = {
            "TM22": {
                "D1": {"stops": [{"stop_id": "2023", "name": "А"}]},
                "D2": {"stops": [{"stop_id": "0470", "name": "Б"}]},
            }
        }
        with self.assertRaises(ValueError):
            build_trip_destinations(directions, schedules, self.routes)

    def test_metro_output_is_compact_and_excludes_surface_routes(self):
        result = build_metro_board_data(
            self.routes, self.directions, self.schedules, self.calendar
        )
        self.assertEqual(set(result["routes"]), {"M1"})
        direction = result["routes"]["M1"]["directions"]["D1"]
        self.assertEqual(direction["stop_ids"], ["M1", "M16"])
        self.assertEqual(direction["terminal_stop_id"], "M16")
        self.assertEqual(direction["destination"], "Бизнес парк София")
        self.assertEqual(direction["weekday"][0]["times"], ["05:00:00", "05:30:00"])
        self.assertEqual(result["calendar"]["dateOverrides"]["2026-11-14"], "weekend")
        self.assertEqual(result["calendar"]["dateTypes"]["2026-11-13"], "weekday")
        self.assertEqual(result["calendar"]["dateTypes"]["2026-12-24"], "weekday", "explicit future overrides take priority")
        self.assertEqual(result["calendar"]["dateTypes"]["2026-12-25"], "weekend", "active GTFS service IDs identify holiday/weekend service")
        self.assertEqual(result["calendar"]["dateTypes"]["2026-12-26"], "weekend", "ties use the calendar date's normal weekday/weekend classification")


if __name__ == "__main__":
    unittest.main()
