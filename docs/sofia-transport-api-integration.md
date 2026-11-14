# Sofia Transport API integration

GTSofia uses [Sofia Transport API](https://github.com/tanislavivanov/sofia-transport-api)
for realtime arrivals on buses, trams and trolleybuses.

## What remains local in GTSofia

- The daily GTFS data generation pipeline remains unchanged.
- Static timetable times and service calendars continue to come from `data/`.
- Stop names remain OSM-first (`osm_stop_name` and the related OSM fields in
  `data/stops.json`).
- Route colours, icons, line labels, direction patterns and terminal-stop
  resolution continue to use the local generated GTFS/OSM data.
- Metro does not call Sofia Transport API. It remains schedule-only.

The frontend still requests `/api/virtual-board?stop_code=...` and only renders
its response. The serverless handler calls Sofia Transport API, maps the
returned `arrival.id` to an exact local GTFS `trip_id`, and merges those realtime
predictions with the local timetable.

## Deploy the upstream API

The GitHub repository contains the API server source, not a hosted public
production URL. Deploy it as a separate Node.js 18+ service using the upstream
instructions:

```bash
npm install
npm start
```

Set `PORT` if the hosting provider expects a specific port. The deployment
should expose these routes:

- `GET /health`
- `GET /api/stops/:code/arrivals?limit=100`

Test the deployed service before connecting GTSofia:

```bash
curl https://YOUR-SERVICE.example/health
curl 'https://YOUR-SERVICE.example/api/stops/0605/arrivals?limit=100'
```

The arrivals response should contain an `arrivals` array with `id`,
`arrivalDate` and `delaySeconds` fields.

## Configure GTSofia

Set this server-side environment variable in the deployment that hosts the
GTSofia `/api/virtual-board` function:

```text
SOFIA_TRANSPORT_API_URL=https://YOUR-SERVICE.example
```

Use only the service origin/base URL (no `/api/...` suffix). Restart or
redeploy the GTSofia API after setting the variable.

When the variable is missing or the upstream service is unavailable, GTSofia
continues to return the local static timetable and reports realtime as
unavailable. Metro never calls the upstream API and always reports
`realtime_status: "not_applicable"`.

## Refresh and caching

The upstream API caches realtime trip updates for approximately one minute.
GTSofia now refreshes both realtime and schedule-only boards every 60 seconds,
so consecutive requests are aligned with the upstream refresh cadence.

## Mapping notes

Sofia Transport API creates each arrival ID in the form
`<trip_id>-<stop_id>-<unix_timestamp>`. GTSofia resolves the trip ID against its
local `data/trips.json`, checks that the stop ID corresponds to the selected
public stop code, and then uses local `schedules.json`, `directions.json`,
`routes.json` and `stops.json` to preserve local timetable and OSM display
behaviour. Arrivals that cannot be mapped exactly are ignored rather than
being assigned to a potentially incorrect line/course.

The upstream API currently does not expose the GTFS-Realtime FeedHeader
timestamp. GTSofia therefore does not label request time as the feed timestamp
or use it to retire realtime course history; the browser retains its existing
arrival-history protection based on the exact course identity and predicted
arrival time.

## Known functional differences to validate

The upstream `/api/stops/:code/arrivals` implementation currently emits only
stop-time updates that contain an absolute event time. It does not include
standalone `SKIPPED` or cancelled-trip records in the arrivals response. As a
result, this first integration overlays exact realtime predictions on the
local schedule, but it cannot yet suppress a static departure solely because
the upstream feed marks that stop skipped or the trip cancelled. The upstream
`/api/trip-updates` endpoint exposes parsed stop updates, but its current parser
does not expose the TripDescriptor-level schedule relationship for cancelled
trips.

The upstream API also does not return the GTFS-Realtime FeedHeader timestamp.
GTSofia deliberately leaves `realtime_feed_timestamp` null instead of
pretending that the time of the HTTP request is the upstream feed timestamp.
For browser-side course-history reconciliation only, GTSofia uses
`refreshed_at` as the timestamp of its successful response snapshot when at
least one arrival was mapped. If a previously observed realtime course is
absent from that non-empty next snapshot, its later GTFS fallback is suppressed.
An empty response or an unavailable API does not retire prior course history,
so normal static fallback remains available in those cases. This snapshot time
is not represented as a GTFS-Realtime FeedHeader timestamp.

## Display horizon

GTSofia keeps at most three upcoming times per route/destination row. Static
and realtime arrivals are currently limited to the next 120 minutes (two
hours). A row can therefore contain only two times when no third eligible
arrival exists inside that horizon; this is intentional and does not imply a
missing course. The lookahead can be extended separately if the product should
show departures further into the future.

These differences should be checked against real stop boards before removing
any remaining compatibility logic or treating the integration as a complete
one-for-one replacement of the previous realtime engine.
