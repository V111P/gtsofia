/** Pure GTFS-RT TripUpdate to stop-arrival mapper. No static timetable fallback. */
const MAX_ARRIVALS_PER_REQUEST = 100;
const PAST_GRACE_MS = 60_000;

function getEvent(stu) {
  // A skipped or NO_DATA stop must never produce an arrival, even if a producer
  // sends an inconsistent event payload alongside the relationship flag.
  const relationship = Number(stu?.scheduleRelationship ?? 0);
  if (relationship === 1 || relationship === 2) return null;
  if (stu?.arrival?.time) return stu.arrival;
  if (stu?.departure?.time) return stu.departure;
  return null;
}

/** Pure mapper exported for regression tests. It only emits explicit RT events. */
export function extractRealtimeArrivals(entities, stopIds, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const limitValue = Number.parseInt(options.limit, 10);
  const limit = Number.isFinite(limitValue)
    ? Math.min(Math.max(limitValue, 1), MAX_ARRIVALS_PER_REQUEST)
    : 20;
  const tripLookup = options.tripLookup || Object.create(null);
  const wantedStopIds = new Set((Array.isArray(stopIds) ? stopIds : []).map(String));
  const predictions = [];

  if (!wantedStopIds.size) return [];

  for (const entity of Array.isArray(entities) ? entities : []) {
    // Explicitly exclude canceled and deleted trips.
    if (entity.tripScheduleRelationship === 3 || entity.tripScheduleRelationship === 7) continue;

    const tripInfo = tripLookup[entity.tripId] || {
      tripId: entity.tripId,
      routeId: entity.routeId || '',
      routeShortName: '',
      routeType: '',
      routeColor: '',
      routeTextColor: '',
      headsign: ''
    };

    for (const stu of Array.isArray(entity.stopTimeUpdates) ? entity.stopTimeUpdates : []) {
      if (!wantedStopIds.has(String(stu?.stopId ?? ''))) continue;
      const event = getEvent(stu);
      if (!event?.time) continue;

      const timestampMs = Date.parse(event.time);
      if (!Number.isFinite(timestampMs) || timestampMs < now - PAST_GRACE_MS) continue;

      predictions.push({
        id: `${entity.tripId}-${stu.stopId}-${Math.floor(timestampMs / 1000)}`,
        tripId: entity.tripId,
        routeId: tripInfo.routeId || entity.routeId || '',
        routeShortName: tripInfo.routeShortName || '',
        routeType: tripInfo.routeType || '',
        routeColor: tripInfo.routeColor || '',
        routeTextColor: tripInfo.routeTextColor || '',
        headsign: tripInfo.headsign || '',
        stopId: stu.stopId,
        arrivalDate: event.time,
        delaySeconds: event.delay ?? stu.departure?.delay ?? stu.arrival?.delay ?? null,
        feedTimestamp: entity.feedTimestamp,
        isRealtime: true
      });
    }
  }

  predictions.sort((a, b) => Date.parse(a.arrivalDate) - Date.parse(b.arrivalDate));
  const unique = new Map();
  for (const prediction of predictions) unique.set(prediction.id, prediction);
  return [...unique.values()].slice(0, limit);
}
