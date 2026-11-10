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


OSM name updates are failure-safe: the generator merges fresh Overpass results
with the last known-good `data/stops.json` snapshot. If Overpass is unavailable
or returns only a partial result, existing OSM names are retained and GTFS
remains only the fallback for stops that have never had an OSM name.
