import importlib.util
from datetime import date
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "Scripts" / "generate_transport_data.py"
spec = importlib.util.spec_from_file_location("generate_transport_data", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CalendarTests(unittest.TestCase):
    def setUp(self):
        self.calendar = [
            {
                "service_id": "WD",
                "monday": "1", "tuesday": "1", "wednesday": "1",
                "thursday": "1", "friday": "1", "saturday": "0", "sunday": "0",
                "start_date": "20260901", "end_date": "20260930",
            },
            {
                "service_id": "WE",
                "monday": "0", "tuesday": "0", "wednesday": "0",
                "thursday": "0", "friday": "0", "saturday": "1", "sunday": "1",
                "start_date": "20260901", "end_date": "20260930",
            },
        ]
        self.calendar_dates = [
            {"service_id": "WD", "date": "20260922", "exception_type": "2"},
            {"service_id": "WE", "date": "20260922", "exception_type": "1"},
        ]

    def test_gtfs_exception_does_not_define_ui_day_type(self):
        service_types, calendar_result = module.build_calendar_context(
            self.calendar,
            self.calendar_dates,
            date(2026, 9, 22),
            horizon_days=0,
        )

        self.assertEqual(
            calendar_result["dateTypes"]["2026-09-22"],
            "weekday",
        )
        self.assertEqual(
            calendar_result["serviceIdsByDate"]["2026-09-22"],
            ["WE"],
        )
        self.assertNotIn("WD", service_types)
        self.assertEqual(service_types["WE"], ["weekday"])

    def test_central_calendar_override_defines_ui_day_type(self):
        service_types, calendar_result = module.build_calendar_context(
            self.calendar,
            self.calendar_dates,
            date(2026, 9, 22),
            horizon_days=0,
            calendar_config={
                "dateOverrides": {
                    "2026-09-22": "weekend",
                },
            },
        )

        self.assertEqual(
            calendar_result["dateTypes"]["2026-09-22"],
            "weekend",
        )
        self.assertNotIn("WD", service_types)
        self.assertEqual(service_types["WE"], ["weekend"])

    def test_service_operating_in_both_buckets_is_preserved(self):
        daily = [
            {
                "service_id": "DAILY",
                "monday": "1", "tuesday": "1", "wednesday": "1",
                "thursday": "1", "friday": "1", "saturday": "1", "sunday": "1",
                "start_date": "20260901", "end_date": "20260930",
            }
        ]

        service_types, _ = module.build_calendar_context(
            daily,
            [],
            date(2026, 9, 21),
            horizon_days=6,
        )

        self.assertEqual(service_types["DAILY"], ["weekday", "weekend"])

    def test_raw_calendar_exceptions_are_not_persisted_and_coverage_is_full(self):
        dates_only = [
            {"service_id": "A", "date": "20260921", "exception_type": "1"},
            {"service_id": "A", "date": "20260930", "exception_type": "1"},
            {"service_id": "A", "date": "20260922", "exception_type": "2"},
        ]

        _, calendar_result = module.build_calendar_context(
            [], dates_only, date(2026, 9, 21), horizon_days=0
        )

        self.assertEqual(calendar_result["exceptions"], [])
        self.assertEqual(calendar_result["servicePatterns"], [])
        self.assertEqual(
            calendar_result["serviceCoverageEndDate"], "2026-09-30"
        )
        self.assertEqual(
            calendar_result["serviceIdsByDate"]["2026-09-21"], ["A"]
        )
        self.assertEqual(
            calendar_result["serviceIdsByDate"]["2026-09-22"], []
        )
        self.assertEqual(
            calendar_result["serviceIdsByDate"]["2026-09-30"], ["A"]
        )
        self.assertEqual(len(calendar_result["serviceIdsByDate"]), 10)

    def test_trip_available_in_both_buckets_is_written_to_both_schedules(self):
        directions = {
            "R1": {
                "D1": {
                    "code": "1",
                }
            }
        }
        logical_trips = [
            {
                "id": 1,
                "route_id": "R1",
                "direction_code": "1",
                "day_types": ["weekday", "weekend"],
                "is_deleted": False,
            }
        ]
        logical_stop_times = [
            {
                "trip": 1,
                "times": [330],
                "car": "",
            }
        ]

        result = module.build_schedules(
            directions,
            logical_trips,
            logical_stop_times,
        )

        self.assertEqual(len(result["R1"]["D1"]["weekday"]), 1)
        self.assertEqual(len(result["R1"]["D1"]["weekend"]), 1)

    def test_calendar_dates_only_feed_uses_explicit_service_dates(self):
        dates_only = [
            {"service_id": "A", "date": "20260921", "exception_type": "1"},
            {"service_id": "A", "date": "20260926", "exception_type": "1"},
        ]

        service_types, calendar_result = module.build_calendar_context(
            [],
            dates_only,
            date(2026, 9, 21),
            horizon_days=5,
        )

        self.assertEqual(
            calendar_result["dateTypes"]["2026-09-21"],
            "weekday",
        )
        self.assertEqual(
            calendar_result["dateTypes"]["2026-09-26"],
            "weekend",
        )
        self.assertEqual(service_types["A"], ["weekday", "weekend"])


if __name__ == "__main__":
    unittest.main()
