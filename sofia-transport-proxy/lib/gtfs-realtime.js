/**
 * GTFS-Realtime trip-updates fetcher.
 * Protobuf decoding uses gtfs-realtime-bindings from the Sofia Public
 * Transport API upstream project; normalization is extended for GTSofia.
 */
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { normalizeDecodedFeed } from './gtfs-realtime-normalizer.js';

const TRIP_UPDATES_URL = 'https://gtfs.sofiatraffic.bg/api/v1/trip-updates';
const CACHE_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

let cachedFeed = null;
let cachedAt = 0;
let inflight = null;

function decodeFeed(buffer) {
  const decoded = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
  return normalizeDecodedFeed(decoded);
}

export async function fetchTripUpdates({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedFeed && Date.now() - cachedAt < CACHE_TTL_MS) return cachedFeed;
  if (inflight) return inflight;

  inflight = (async () => {
    const response = await fetch(TRIP_UPDATES_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/x-protobuf, application/octet-stream' },
    });
    if (!response.ok) throw new Error(`Sofia Traffic GTFS-RT returned HTTP ${response.status}.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('Sofia Traffic GTFS-RT feed is empty.');
    const result = decodeFeed(buffer);
    cachedFeed = result;
    cachedAt = Date.now();
    return result;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

export function clearRealtimeCacheForTests() {
  cachedFeed = null;
  cachedAt = 0;
  inflight = null;
}
