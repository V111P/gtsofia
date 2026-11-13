/**
 * Combined stop-arrival lookup: explicit GTFS-RT first, timetable fallback per
 * exact trip and stop. Metro timetable rows are intentionally not included;
 * metro continues to use its separate compact timetable implementation.
 */
import { getTripLookup, getStopIdsByIdentifier } from './gtfs-static.js';
import { fetchTripUpdates, getRealtimeFeedTimestamp } from './gtfs-realtime.js';
import { extractRealtimeArrivals } from './arrival-mapper.js';
import { getScheduleData } from './schedule-data.js';
import { extractScheduledArrivals, mergeRealtimeAndScheduledArrivals, enrichRealtimeArrivalsFromSchedule } from './schedule-mapper.js';

export { extractRealtimeArrivals, extractScheduledArrivals, mergeRealtimeAndScheduledArrivals };

const MAX_ARRIVALS_PER_REQUEST = 1000;

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

  const rawRealtimeArrivals = requestedStopIds.length
    ? extractRealtimeArrivals(updates, requestedStopIds, {
        now,
        limit: MAX_ARRIVALS_PER_REQUEST,
        tripLookup
      })
    : [];

  // The compact timetable index contains the OSM-first terminal destination
  // for the exact static trip. Reuse it on RT records too, so a GTFS trip_headsign
  // does not leak through to the board when it is not an OSM stop label. The
  // Vercel mapper can still override this for a recognized RT short-turn headsign.
  const realtimeArrivals = enrichRealtimeArrivalsFromSchedule(
    rawRealtimeArrivals,
    scheduledArrivals
  );

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
