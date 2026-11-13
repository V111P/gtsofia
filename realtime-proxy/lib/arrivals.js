/** Realtime-only stop arrival lookup. It never creates timetable-based arrivals. */
import { getTripLookup, getStopIdsByIdentifier } from './gtfs-static.js';
import { fetchTripUpdates, getRealtimeFeedTimestamp } from './gtfs-realtime.js';
import { extractRealtimeArrivals } from './arrival-mapper.js';

export { extractRealtimeArrivals };

const MAX_ARRIVALS_PER_REQUEST = 100;

export async function getArrivalsByIdentifier(code, options = {}) {
  const requestedLimit = Number.parseInt(options.limit, 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_ARRIVALS_PER_REQUEST)
    : 20;

  const stopIds = await getStopIdsByIdentifier(code);
  if (!stopIds.length) {
    return { arrivals: [], count: 0, feedTimestamp: getRealtimeFeedTimestamp() };
  }

  const [tripLookup, updates] = await Promise.all([getTripLookup(), fetchTripUpdates()]);
  const arrivals = extractRealtimeArrivals(updates, stopIds, {
    now: options.now,
    limit,
    tripLookup
  });

  return {
    arrivals,
    count: arrivals.length,
    feedTimestamp: getRealtimeFeedTimestamp()
  };
}
