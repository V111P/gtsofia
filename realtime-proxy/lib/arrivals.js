/**
 * Combined stop-arrival lookup: explicit GTFS-RT first, timetable fallback per
 * exact trip and stop. Metro timetable rows are intentionally not included;
 * metro continues to use its separate compact timetable implementation.
 */
import { getTripLookup, getStopIdsByIdentifier } from './gtfs-static.js';
import { fetchTripUpdates, getRealtimeFeedTimestamp } from './gtfs-realtime.js';
import { extractRealtimeArrivals } from './arrival-mapper.js';
import { getScheduleData } from './schedule-data.js';
import { extractScheduledArrivals, mergeRealtimeAndScheduledArrivals } from './schedule-mapper.js';

export { extractRealtimeArrivals, extractScheduledArrivals, mergeRealtimeAndScheduledArrivals };

const MAX_ARRIVALS_PER_REQUEST = 100;

export async function getArrivalsByIdentifier(code, options = {}) {
  const requestedLimit = Number.parseInt(options.limit, 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_ARRIVALS_PER_REQUEST)
    : 20;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();

  const scheduleData = await getScheduleData();
  const scheduledArrivals = extractScheduledArrivals(scheduleData, code, { nowMs: now });

  const [stopIdsResult, tripLookupResult, updatesResult] = await Promise.allSettled([
    getStopIdsByIdentifier(code),
    getTripLookup(),
    fetchTripUpdates()
  ]);

  const requestedStopIds = stopIdsResult.status === 'fulfilled' ? stopIdsResult.value : [];
  const tripLookup = tripLookupResult.status === 'fulfilled' ? tripLookupResult.value : Object.create(null);
  const updates = updatesResult.status === 'fulfilled' ? updatesResult.value : [];
  const realtimeAvailable = updatesResult.status === 'fulfilled'
    && stopIdsResult.status === 'fulfilled'
    && requestedStopIds.length > 0;
  const realtimeError = updatesResult.status === 'rejected'
    ? String(updatesResult.reason?.message || updatesResult.reason || 'Realtime feed unavailable.')
    : (stopIdsResult.status === 'rejected'
      ? String(stopIdsResult.reason?.message || stopIdsResult.reason || 'Static stop lookup unavailable.')
      : (requestedStopIds.length ? '' : 'No GTFS stop IDs matched this public stop identifier.'));

  const realtimeArrivals = requestedStopIds.length
    ? extractRealtimeArrivals(updates, requestedStopIds, {
        now,
        limit: MAX_ARRIVALS_PER_REQUEST,
        tripLookup
      })
    : [];

  const arrivals = mergeRealtimeAndScheduledArrivals({
    realtimeArrivals,
    scheduledArrivals,
    updates,
    requestedStopIds,
    stopIdentifier: code
  }).slice(0, limit);

  const realtimeCount = arrivals.filter(arrival => arrival.isRealtime === true).length;
  const scheduledCount = arrivals.filter(arrival => arrival.isScheduled === true).length;

  return {
    arrivals,
    count: arrivals.length,
    realtimeCount,
    scheduledCount,
    realtimeAvailable,
    realtimeError,
    feedTimestamp: realtimeAvailable ? getRealtimeFeedTimestamp() : null,
    scheduleGeneratedAt: scheduleData.generatedAt || null
  };
}
