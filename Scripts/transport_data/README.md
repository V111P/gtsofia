# Generator modules

- `config.py` — repository paths, settings, and common normalization helpers.
- `gtfs.py` — download and read the official GTFS archive.
- `osm.py` — retrieve public stop names and enrich GTFS stops.
- `calendar.py` — derive schedule day-types and the compact active-service date index.
- `stops.py` — normalize stops and build stop indexes.
- `trips.py` — filter active trips and index stop times.
- `directions.py` — build, merge and label logical directions.
- `schedules.py` — construct weekday/weekend timetable records.
- `shapes.py` — load and normalize route geometry.
- `output.py` — write the independently cacheable JSON data files.
- `pipeline.py` — orchestrate the generation steps.

`../generate_transport_data.py` remains the executable entry point and re-exports
commonly used functions so existing tests and scripts can continue importing it.


OSM name updates use a primary Overpass instance plus fallback mirrors. The
query covers node, way and relation stop objects, including the standard
`railway=station` tagging used by metro stations. A response is accepted only
when it contains at least 3,000 named public stops.

The generator merges a complete fresh response with the last known-good
`data/stops.json` snapshot. If Overpass is unavailable or returns only a
partial result, the previous complete OSM snapshot is retained. If there is no
complete snapshot to fall back to, generation stops before writing any output
files; it must never publish a GTFS-only replacement merely because the OSM
service failed.
