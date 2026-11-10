import importlib.util
import json
import unittest
from pathlib import Path
from urllib.error import URLError
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "Scripts" / "generate_transport_data.py"
SPEC = importlib.util.spec_from_file_location("gtsofia_transport_generator", MODULE_PATH)
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)
import transport_data.osm as OSM_MODULE  # noqa: E402


class _FakeResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self):
        return self.payload


class OSMStopNameTests(unittest.TestCase):
    def test_checked_in_stop_snapshot_has_osm_first_names(self):
        snapshot = ROOT / "data" / "stops.json"
        with snapshot.open("r", encoding="utf-8") as file:
            rows = json.load(file)

        osm_named = [
            row for row in rows
            if row.get("stop_name_source") == "osm"
            and row.get("osm_stop_name")
            and row.get("stop_name") == row.get("osm_stop_name")
        ]

        # Prevent a failed Overpass fetch from silently committing a full
        # GTFS-only snapshot in place of the existing OSM-first names.
        self.assertGreaterEqual(len(osm_named), 3000)

    def test_osm_stop_codes_follow_public_code_convention(self):
        self.assertEqual(
            GENERATOR.normalize_osm_stop_code({"ref": "328", "bus": "yes"}),
            "0328",
        )
        self.assertEqual(
            GENERATOR.normalize_osm_stop_code(
                {"ref": "18", "subway": "yes", "railway": "station"}
            ),
            "M18",
        )
        self.assertEqual(
            GENERATOR.normalize_osm_stop_code(
                {"ref": "18", "station": "subway", "railway": "station"}
            ),
            "M18",
        )
        self.assertEqual(
            GENERATOR.normalize_osm_stop_code(
                {"ref": "M18", "station": "subway", "railway": "station"}
            ),
            "M18",
        )
        self.assertEqual(
            GENERATOR.normalize_osm_stop_code(
                {"ref": "m18", "station": "subway", "railway": "station"}
            ),
            "M18",
        )
        self.assertEqual(
            GENERATOR.normalize_osm_stop_code({"ref": "", "bus": "yes"}),
            "",
        )

    def test_osm_query_covers_standard_metro_tags_and_non_node_platforms(self):
        query = GENERATOR.build_osm_stop_query()

        self.assertIn('nwr[subway="yes"][railway="station"]', query)
        self.assertIn('nwr[station="subway"][railway="station"]', query)
        self.assertIn('nwr[bus="yes"][highway="bus_stop"]', query)
        self.assertIn("out center tags;", query)

    def test_blank_name_falls_back_to_name_bg(self):
        rows = OSM_MODULE._parse_osm_stop_elements([
            {
                "type": "node",
                "id": 123,
                "tags": {
                    "bus": "yes",
                    "public_transport": "platform",
                    "ref": "0328",
                    "network": "Градски транспорт София",
                    "name": "   ",
                    "name:bg": "бул. К. Величков",
                },
            }
        ])

        self.assertEqual(rows["0328"]["osm_stop_name"], "бул. К. Величков")

    def test_fetch_osm_stops_retries_fallback_endpoint(self):
        elements = [
            {
                "type": "node",
                "id": index,
                "tags": {
                    "bus": "yes",
                    "public_transport": "platform",
                    "ref": str(index),
                    "network": "Градски транспорт София",
                    "name": f"OSM спирка {index}",
                },
            }
            for index in range(1, GENERATOR.OSM_MIN_NAMED_STOPS + 1)
        ]
        calls = []

        def fake_urlopen(request, timeout):
            calls.append(request.full_url)
            if request.full_url == GENERATOR.OSM_URL:
                raise URLError("primary endpoint unavailable")
            return _FakeResponse({"elements": elements})

        with patch.object(OSM_MODULE.urllib.request, "urlopen", side_effect=fake_urlopen):
            result = GENERATOR.fetch_osm_stops()

        self.assertEqual(calls[0], GENERATOR.OSM_URL)
        self.assertEqual(calls[1], GENERATOR.OSM_FALLBACK_URLS[0])
        self.assertEqual(len(result), GENERATOR.OSM_MIN_NAMED_STOPS)
        self.assertEqual(result["0328"]["osm_stop_name"], "OSM спирка 328")

    def test_old_osm_snapshot_format_is_migrated(self):
        previous = GENERATOR.previous_osm_stops_from_rows([
            {
                "stop_id": "0328",
                "stop_code": "0328",
                "stop_name": "бул. К. Величков",
                "stop_name_source": "osm",
            }
        ])

        self.assertEqual(previous["0328"]["osm_stop_name"], "бул. К. Величков")

    def test_incomplete_fresh_snapshot_does_not_replace_previous_snapshot(self):
        previous = {
            f"{index:04d}": {"osm_stop_name": f"Стара OSM спирка {index}"}
            for index in range(1, GENERATOR.OSM_MIN_NAMED_STOPS + 1)
        }
        fresh = {"0001": {"osm_stop_name": "Частично обновено име"}}

        selected, accepted_fresh = GENERATOR.resolve_osm_stop_snapshot(fresh, previous)

        self.assertIsNone(accepted_fresh)
        self.assertEqual(len(selected), len(previous))
        self.assertEqual(selected["0001"]["osm_stop_name"], "Стара OSM спирка 1")

    def test_generation_refuses_to_publish_without_complete_osm_snapshot(self):
        with self.assertRaisesRegex(RuntimeError, "Refusing to publish GTFS-only"):
            GENERATOR.resolve_osm_stop_snapshot(None, {})

    def test_osm_name_wins_and_gtfs_name_is_preserved(self):
        stops = GENERATOR.enrich_stops_with_osm(
            [
                {
                    "stop_id": "0328",
                    "stop_code": "0328",
                    "stop_name": "БУЛ. К. ВЕЛИЧКОВ",
                    "location_type": "0",
                }
            ],
            {
                "0328": {
                    "osm_stop_name": "бул. К. Величков",
                    "osm_stop_name_en": "bul. K. Velichkov",
                    "osm_local_ref": "1",
                }
            },
        )

        self.assertEqual(stops[0]["stop_name"], "бул. К. Величков")
        self.assertEqual(stops[0]["osm_stop_name"], "бул. К. Величков")
        self.assertEqual(stops[0]["gtfs_stop_name"], "БУЛ. К. ВЕЛИЧКОВ")
        self.assertEqual(stops[0]["stop_name_source"], "osm")
        self.assertEqual(stops[0]["osm_local_ref"], "1")

    def test_missing_osm_name_falls_back_to_gtfs(self):
        stops = GENERATOR.enrich_stops_with_osm(
            [
                {
                    "stop_id": "9999",
                    "stop_code": "9999",
                    "stop_name": "GTFS резервно име",
                    "location_type": "0",
                }
            ],
            {
                "9999": {
                    "osm_stop_name": "",
                    "osm_local_ref": "A",
                }
            },
        )

        self.assertEqual(stops[0]["stop_name"], "GTFS резервно име")
        self.assertEqual(stops[0]["gtfs_stop_name"], "GTFS резервно име")
        self.assertEqual(stops[0]["stop_name_source"], "gtfs")

    def test_previous_osm_names_survive_failed_overpass_request(self):
        previous = GENERATOR.previous_osm_stops_from_rows(
            [
                {
                    "stop_id": "0328",
                    "stop_code": "0328",
                    "osm_stop_name": "бул. К. Величков",
                    "osm_stop_name_en": "K. Velichkov Blvd",
                    "gtfs_stop_name": "БУЛ. К. ВЕЛИЧКОВ",
                }
            ]
        )
        merged = GENERATOR.merge_osm_stop_snapshots(None, previous)
        stops = GENERATOR.enrich_stops_with_osm(
            [
                {
                    "stop_id": "0328",
                    "stop_code": "0328",
                    "stop_name": "БУЛ. К. ВЕЛИЧКОВ",
                }
            ],
            merged,
        )

        self.assertEqual(stops[0]["stop_name"], "бул. К. Величков")
        self.assertEqual(stops[0]["stop_name_source"], "osm")
        self.assertEqual(stops[0]["gtfs_stop_name"], "БУЛ. К. ВЕЛИЧКОВ")

    def test_partial_osm_response_keeps_previous_names_for_missing_stops(self):
        previous = GENERATOR.previous_osm_stops_from_rows(
            [
                {"stop_id": "0328", "stop_code": "0328", "osm_stop_name": "OSM старо име"},
                {"stop_id": "0329", "stop_code": "0329", "osm_stop_name": "OSM име 2"},
            ]
        )
        merged = GENERATOR.merge_osm_stop_snapshots(
            {"0328": {"osm_stop_name": "OSM обновено име"}},
            previous,
        )

        self.assertEqual(merged["0328"]["osm_stop_name"], "OSM обновено име")
        self.assertEqual(merged["0329"]["osm_stop_name"], "OSM име 2")

    def test_nameless_partial_osm_record_does_not_erase_previous_name(self):
        previous = {"0328": {"osm_stop_name": "OSM име"}}
        merged = GENERATOR.merge_osm_stop_snapshots(
            {"0328": {"osm_stop_name": "", "osm_local_ref": "A"}},
            previous,
        )

        self.assertEqual(merged["0328"]["osm_stop_name"], "OSM име")
        self.assertEqual(merged["0328"]["osm_local_ref"], "A")

    def test_osm_terminal_stop_name_wins_over_gtfs_headsign(self):
        stops, stops_by_id = GENERATOR.build_stops(
            GENERATOR.enrich_stops_with_osm(
                [
                    {
                        "stop_id": "0001",
                        "stop_code": "0001",
                        "stop_name": "GTFS начало",
                        "location_type": "0",
                    },
                    {
                        "stop_id": "0002",
                        "stop_code": "0002",
                        "stop_name": "GTFS край",
                        "location_type": "0",
                    },
                ],
                {
                    "0001": {"osm_stop_name": "OSM начало"},
                    "0002": {"osm_stop_name": "OSM край"},
                },
            )
        )

        name = GENERATOR.choose_direction_name(
            {
                "stops": ["0001", "0002"],
                "headsigns": ["GTFS направление", "GTFS направление"],
            },
            stops_by_id,
        )
        self.assertEqual(name, "OSM край")

    def test_legacy_osm_display_name_wins_over_gtfs_headsign(self):
        _, stops_by_id = GENERATOR.build_stops([
            {
                "stop_id": "0002",
                "stop_code": "0002",
                "stop_name": "Стара OSM крайна спирка",
                "stop_name_source": "osm",
                "location_type": "0",
            }
        ])

        name = GENERATOR.choose_direction_name(
            {"stops": ["0002"], "headsigns": ["GTFS направление"]},
            stops_by_id,
        )
        self.assertEqual(name, "Стара OSM крайна спирка")

    def test_gtfs_headsign_is_fallback_when_terminal_has_no_osm_name(self):
        _, stops_by_id = GENERATOR.build_stops(
            GENERATOR.enrich_stops_with_osm(
                [
                    {
                        "stop_id": "0002",
                        "stop_code": "0002",
                        "stop_name": "GTFS край",
                        "location_type": "0",
                    }
                ],
                {},
            )
        )

        name = GENERATOR.choose_direction_name(
            {"stops": ["0002"], "headsigns": ["GTFS направление"]},
            stops_by_id,
        )
        self.assertEqual(name, "GTFS направление")


if __name__ == "__main__":
    unittest.main()
