/**
 * GTFS-Realtime TripUpdates fetcher adapted from tanislavivanov/sofia-transport-api (MIT).
 * Only explicit arrival/departure event timestamps are exposed to the board.
 */
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const TRIP_UPDATES_URL = 'https://gtfs.sofiatraffic.bg/api/v1/trip-updates';
const CACHE_TTL_MS = 60_000;
const MAX_FEED_AGE_SECONDS = 120;
const MAX_FEED_FUTURE_SKEW_SECONDS = 60;

let cached = null;
let cachedAt = 0;
let cachedFeedTimestamp = null;

function toNumber(value) {
  if (value == null) return NaN;
  if (typeof value === 'number') return value;
  if (typeof value?.toNumber === 'function') return value.toNumber();
  return Number(value);
}

export function getRealtimeFeedTimestamp() {
  return cachedFeedTimestamp;
}

export async function fetchTripUpdates() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cachedAgeSeconds = cachedFeedTimestamp == null
    ? Number.POSITIVE_INFINITY
    : nowSeconds - cachedFeedTimestamp;
  const cachedStillFresh = cachedAgeSeconds <= MAX_FEED_AGE_SECONDS
    && cachedAgeSeconds >= -MAX_FEED_FUTURE_SKEW_SECONDS;
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS && cachedStillFresh) return cached;

  // Never serve cached predictions once their source feed has become stale.
  if (!cachedStillFresh) {
    cached = null;
    cachedAt = 0;
    cachedFeedTimestamp = null;
  }

  const response = await fetch(TRIP_UPDATES_URL, {
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/x-protobuf, application/octet-stream' }
  });
  if (!response.ok) throw new Error(`GTFS Realtime trip updates: HTTP ${response.status}`);

  const buffer = new Uint8Array(await response.arrayBuffer());
  if (!buffer.byteLength) throw new Error('GTFS Realtime trip updates feed is empty.');

  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
  const feedTimestamp = toNumber(feed?.header?.timestamp);
  if (!Number.isSafeInteger(feedTimestamp) || feedTimestamp <= 0) {
    throw new Error('GTFS Realtime feed has no valid header timestamp.');
  }

  const feedNowSeconds = Math.floor(Date.now() / 1000);
  const ageSeconds = feedNowSeconds - feedTimestamp;
  if (ageSeconds > MAX_FEED_AGE_SECONDS) {
    throw new Error(`GTFS Realtime feed is stale (${ageSeconds}s old).`);
  }
  if (ageSeconds < -MAX_FEED_FUTURE_SKEW_SECONDS) {
    throw new Error('GTFS Realtime feed timestamp is too far in the future.');
  }

  const entities = feed.entity || feed.entities || [];
  const updates = [];
  for (const entity of entities) {
    const update = entity.tripUpdate || entity.trip_update;
    if (!update) continue;

    const descriptor = update.trip;
    const tripId = String(descriptor?.tripId ?? descriptor?.trip_id ?? '').trim();
    if (!tripId) continue;

    const stopTimeUpdates = (update.stopTimeUpdate || update.stop_time_update || [])
      .map(stu => {
        const stopId = String(stu.stopId ?? stu.stop_id ?? '').trim();
        if (!stopId) return null;

        const arrival = stu.arrival ? {
          time: toNumber(stu.arrival.time) > 0
            ? new Date(toNumber(stu.arrival.time) * 1000).toISOString()
            : null,
          delay: stu.arrival.delay == null ? null : Number(stu.arrival.delay)
        } : null;
        const departure = stu.departure ? {
          time: toNumber(stu.departure.time) > 0
            ? new Date(toNumber(stu.departure.time) * 1000).toISOString()
            : null,
          delay: stu.departure.delay == null ? null : Number(stu.departure.delay)
        } : null;

        return {
          stopId,
          arrival,
          departure,
          scheduleRelationship: Number(stu.scheduleRelationship ?? stu.schedule_relationship ?? 0)
        };
      })
      .filter(Boolean);

    updates.push({
      entityId: String(entity.id ?? ''),
      tripId,
      routeId: String(descriptor?.routeId ?? descriptor?.route_id ?? '').trim(),
      tripScheduleRelationship: Number(descriptor?.scheduleRelationship ?? descriptor?.schedule_relationship ?? 0),
      timestamp: toNumber(update.timestamp) > 0
        ? new Date(toNumber(update.timestamp) * 1000).toISOString()
        : null,
      feedTimestamp,
      stopTimeUpdates
    });
  }

  cached = updates;
  cachedAt = Date.now();
  cachedFeedTimestamp = feedTimestamp;
  return updates;
}
