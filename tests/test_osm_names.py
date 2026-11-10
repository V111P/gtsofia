import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "Scripts" / "generate_transport_data.py"
SPEC = importlib.util.spec_from_file_location("gtsofia_transport_generator", MODULE_PATH)
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class OSMStopNameTests(unittest.TestCase):
    def test_overpass_query_uses_dimitars_stop_selectors(self):
        query = GENERATOR.build_overpass_query()
        self.assertIn("[out:json][timeout:25]", query)
        self.assertIn("node[subway=yes][public_transport=station]", query)
        self.assertIn("node[tram=yes][public_transport=stop_position]", query)
        self.assertIn("node[bus=yes][public_transport=platform]", query)
        self.assertIn("node[trolleybus=yes][public_transport=platform]", query)
        self.assertIn('network="Градски транспорт София"', query)
        self.assertIn("out geom;", query)
        self.assertNotIn("way[", query)
        self.assertNotIn("relation[", query)

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

    def test_gtfs_rows_use_dimitar_public_code_rule(self):
        self.assertEqual(
            GENERATOR.normalize_gtfs_public_stop_code(
                {"stop_id": "M314", "stop_code": "314"}
            ),
            "M314",
        )
        self.assertEqual(
            GENERATOR.normalize_gtfs_public_stop_code(
                {"stop_id": "0123", "stop_code": "0328"}
            ),
            "0328",
        )
        self.assertEqual(
            GENERATOR.normalize_gtfs_public_stop_code(
                {"stop_id": "0328", "stop_code": "0328"}
            ),
            "0328",
        )
        self.assertEqual(
            GENERATOR.normalize_gtfs_public_stop_code(
                {"stop_id": "0012", "stop_code": ""}
            ),
            "0012",
        )

    def test_previous_snapshot_does_not_alias_metro_code_to_bus_code(self):
        previous = GENERATOR.previous_osm_stops_from_rows(
            [
                {
                    "stop_id": "M314",
                    "stop_code": "314",
                    "osm_stop_name": "Метростанция",
                }
            ]
        )
        self.assertEqual(previous["M314"]["osm_stop_name"], "Метростанция")
        self.assertNotIn("0314", previous)

    def test_metro_stop_does_not_match_a_bus_stop_by_numeric_stop_code(self):
        stops = GENERATOR.enrich_stops_with_osm(
            [
                {
                    "stop_id": "M314",
                    "stop_code": "314",
                    "stop_name": "GTFS име на метростанция",
                }
            ],
            {
                "0314": {"osm_stop_name": "OSM име на автобусна спирка"}
            },
        )
        self.assertEqual(stops[0]["stop_name"], "GTFS име на метростанция")
        self.assertEqual(stops[0]["stop_name_source"], "gtfs")

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
            GENERATOR.normalize_osm_stop_code({"ref": "", "bus": "yes"}),
            "",
        )

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

    def test_gtfs_terminal_stop_name_precedes_gtfs_headsign_when_no_osm_name(self):
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
        self.assertEqual(name, "GTFS край")

    def test_gtfs_headsign_is_last_fallback_when_terminal_stop_has_no_name(self):
        name = GENERATOR.choose_direction_name(
            {"stops": ["missing-stop"], "headsigns": ["GTFS направление"]},
            {},
        )
        self.assertEqual(name, "GTFS направление")

    def test_empty_osm_response_uses_previous_snapshot_instead_of_gtfs_only(self):
        previous = {
            f"{index:04d}": {"osm_stop_name": f"OSM име {index}"}
            for index in range(1, 2101)
        }
        resolved, refreshed = GENERATOR.resolve_osm_snapshot({}, previous)
        self.assertFalse(refreshed)
        self.assertEqual(len(resolved), len(previous))

    def test_empty_osm_response_without_good_snapshot_aborts(self):
        with self.assertRaises(RuntimeError):
            GENERATOR.resolve_osm_snapshot({}, {})


if __name__ == "__main__":
    unittest.main()
