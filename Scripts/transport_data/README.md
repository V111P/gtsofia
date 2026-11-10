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


Stop naming follows the same source priority as `Dimitar5555/sofiatraffic-schedules`:
OSM is the canonical stop-name source, and a GTFS name is used only when that
specific stop has no OSM name. Direction destinations resolve to the name of
the direction's terminal stop before considering the GTFS trip headsign.

OSM refreshes use the same Overpass endpoint and transport selectors as
Dimitar's generator. Responses are validated before publication. If Overpass
fails or returns an implausibly small snapshot, the last known-good OSM names
are reused; when no complete OSM snapshot exists, generation stops rather than
publishing a GTFS-only replacement.
