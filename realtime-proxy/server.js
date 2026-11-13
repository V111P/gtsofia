import express from 'express';
import { getArrivalsByIdentifier } from './lib/arrivals.js';
import { getStops, getTripLookup } from './lib/gtfs-static.js';
import { getScheduleData } from './lib/schedule-data.js';

const app = express();
const port = Number(process.env.PORT || 10000);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Accept, Content-Type');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'gtsofia-realtime-proxy', timestamp: new Date().toISOString() });
});

app.get('/api/stops/:identifier/arrivals', async (req, res) => {
  const stopIdentifier = String(req.params.identifier ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(stopIdentifier)) {
    return res.status(400).json({ error: 'Invalid stop identifier.' });
  }

  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 30;

  try {
    const result = await getArrivalsByIdentifier(stopIdentifier, { limit });
    return res.json({
      provider: 'Sofia Traffic GTFS-RT + GTFS schedule',
      stopIdentifier,
      generatedAt: new Date().toISOString(),
      feedTimestamp: result.feedTimestamp,
      feedAgeSeconds: result.feedTimestamp == null
        ? null
        : Math.max(0, Math.floor(Date.now() / 1000) - result.feedTimestamp),
      realtimeAvailable: result.realtimeAvailable,
      realtimeError: result.realtimeError || null,
      realtimeCount: result.realtimeCount,
      scheduledCount: result.scheduledCount,
      scheduleGeneratedAt: result.scheduleGeneratedAt,
      arrivals: result.arrivals,
      count: result.count
    });
  } catch (error) {
    console.error(`Realtime arrivals failed for stop ${stopIdentifier}:`, error?.message || error);
    return res.status(502).json({
      error: 'Realtime provider is temporarily unavailable.',
      detail: error?.message || 'Unknown upstream error.'
    });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

app.listen(port, '0.0.0.0', () => {
  console.log(`GT Sofia realtime proxy listening on port ${port}`);
  Promise.all([getStops(), getTripLookup(), getScheduleData()])
    .then(([, , scheduleData]) => console.log(
      `GTFS lookups and ${Object.keys(scheduleData.routes || {}).length} surface timetable routes warmed.`
    ))
    .catch(error => console.error('GTFS warmup failed; the first request will retry:', error?.message || error));
});
