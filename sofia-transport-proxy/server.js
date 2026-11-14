import crypto from 'node:crypto';
import express from 'express';
import { getStops, getStopByCode, getRoutes, getTrips, getTripLookup } from './lib/gtfs-static.js';
import { fetchTripUpdates } from './lib/gtfs-realtime.js';
import { getArrivalsByStopCode } from './lib/arrivals.js';
import { serializeFeed } from './lib/api-serialization.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = String(process.env.SOFIA_TRANSPORT_PROXY_API_KEY ?? '').trim();
const NODE_ENV = String(process.env.NODE_ENV ?? 'development');
if (NODE_ENV === 'production' && !API_KEY) {
  throw new Error('SOFIA_TRANSPORT_PROXY_API_KEY is required in production.');
}

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.use('/api', (req, res, next) => {
  if (!API_KEY) return next();
  const bearer = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const supplied = bearer || String(req.get('x-api-key') ?? '').trim();
  if (!supplied || !safeEqual(supplied, API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api', (req, res) => {
  res.json({
    name: 'Sofia Public Transport API',
    description: 'JSON wrapper for Sofia GTFS static and GTFS-Realtime data, adapted for GTSofia.',
    endpoints: [
      'GET /health',
      'GET /api/stops',
      'GET /api/stops/:code',
      'GET /api/stops/:code/arrivals?limit=20',
      'GET /api/trip-updates',
      'GET /api/routes',
      'GET /api/trips',
      'GET /api/trip-lookup',
    ],
    dataSource: 'https://gtfs.sofiatraffic.bg',
    cache: { staticSeconds: 30 * 24 * 60 * 60, realtimeSeconds: 60 },
  });
});

app.get('/api/stops', async (req, res, next) => {
  try {
    const stops = await getStops();
    res.json({ stops, count: stops.length });
  } catch (error) { next(error); }
});

app.get('/api/stops/:code', async (req, res, next) => {
  try {
    const stop = await getStopByCode(req.params.code);
    if (!stop) return res.status(404).json({ error: 'Stop not found' });
    res.json(stop);
  } catch (error) { next(error); }
});

app.get('/api/stops/:code/arrivals', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const [result, feed] = await Promise.all([
      getArrivalsByStopCode(req.params.code, { limit }),
      fetchTripUpdates(),
    ]);
    res.json({
      stopCode: req.params.code,
      arrivals: result.arrivals,
      count: result.count,
      feedTimestamp: feed.feedTimestamp,
    });
  } catch (error) { next(error); }
});

app.get('/api/trip-updates', async (req, res, next) => {
  try {
    const feed = await fetchTripUpdates();
    res.json(serializeFeed(feed));
  } catch (error) { next(error); }
});

app.get('/api/routes', async (req, res, next) => {
  try {
    const routes = await getRoutes();
    res.json({ routes, count: routes.length });
  } catch (error) { next(error); }
});

app.get('/api/trips', async (req, res, next) => {
  try {
    const trips = await getTrips();
    res.json({ trips, count: trips.length });
  } catch (error) { next(error); }
});

app.get('/api/trip-lookup', async (req, res, next) => {
  try {
    const tripLookup = await getTripLookup();
    res.json({ tripLookup });
  } catch (error) { next(error); }
});

app.use((error, req, res, next) => {
  const message = error?.message || 'Proxy request failed';
  console.error(`Sofia Transport API error on ${req.method} ${req.path}: ${message}`);
  if (res.headersSent) return next(error);
  return res.status(502).json({ error: 'Upstream transport data is temporarily unavailable' });
});

app.listen(PORT, () => {
  console.log(`Sofia Transport API proxy listening on port ${PORT}`);
});
