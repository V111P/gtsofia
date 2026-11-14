# GTSofia – Sofia Transport API proxy

This is a self-hosted Node.js service based on the public **Sofia Public Transport API** by Tanislav Ivanov:

- Upstream repository: https://github.com/tanislavivanov/sofia-transport-api
- Upstream license: MIT (the original license is retained in `UPSTREAM-LICENSE`).
- Data source: https://gtfs.sofiatraffic.bg

The upstream API is a server application, not a hosted public endpoint. This folder packages it as a separately deployable service and extends its `/api/trip-updates` JSON response with the full GTFS-Realtime trip descriptor fields GTSofia needs (`startDate`, `startTime`, `directionId`, `scheduleRelationship`, stop sequence, scheduled time and uncertainty).

## Endpoints

- `GET /health` – health check (not API-key protected).
- `GET /api/trip-updates` – decoded GTFS-Realtime updates, including feed timestamp and full trip/stop metadata.
- `GET /api/stops/:code/arrivals?limit=20` – predictions for a public stop code, merging all GTFS `stop_id` values that share that code.
- `GET /api/stops/:code` – stop details and its GTFS `stopIds`.
- `GET /api/stops`, `/api/routes`, `/api/trips`, `/api/trip-lookup` – static-data lookup endpoints.
- `GET /api` – compact endpoint catalogue.

The proxy only returns realtime predictions in `/api/stops/:code/arrivals`; it does **not** generate timetable arrivals or support metro realtime. GTSofia continues to build scheduled arrivals locally from its own static GTFS snapshot. Metro remains schedule-only.

## Run locally

Requirements: Node.js 18 or newer.

```bash
npm install
SOFIA_TRANSPORT_PROXY_API_KEY="choose-a-long-random-secret" npm start
```

Then check:

```text
GET http://localhost:3000/health
GET http://localhost:3000/api/trip-updates
GET http://localhost:3000/api/stops/0605/arrivals
```

When `SOFIA_TRANSPORT_PROXY_API_KEY` is set, all `/api/*` routes require either `Authorization: Bearer <key>` or `X-API-Key: <key>`. The health endpoint remains open for host health checks. The service can run without a key for local development only; set a key in production.

Static GTFS files are cached in memory for about 30 days; realtime trip updates are cached in memory for about 60 seconds and concurrent fetches are coalesced. A process restart clears the cache and the next request reloads data.

## Connect GTSofia

Deploy this folder as a long-running Node service (for example, from the `sofia-transport-proxy` subdirectory on a Node hosting provider). Set these environment variables in the **GTSofia Vercel project**:

- `SOFIA_TRANSPORT_API_URL` – public base URL of this proxy, without a trailing slash, e.g. `https://your-proxy-host.example`.
- `SOFIA_TRANSPORT_PROXY_API_KEY` – same secret configured on the proxy service.

Redeploy GTSofia after setting the variables. Its `/api/virtual-board` endpoint requests decoded JSON from the proxy. If the proxy is not configured or temporarily unavailable, GTSofia automatically falls back to its original direct Sofia Traffic GTFS-Realtime fetcher. Metro never calls the realtime proxy.

Do not put the proxy key in frontend JavaScript or commit it to Git.
