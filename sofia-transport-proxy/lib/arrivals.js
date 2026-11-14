import { getTripLookup, getStopIdsByCode } from './gtfs-static.js';
import { fetchTripUpdates } from './gtfs-realtime.js';

const TRIP_CANCELED = new Set([3, 7]); // CANCELED, DELETED
const STOP_UNAVAILABLE = new Set([1, 2]); // SKIPPED, NO_DATA

export async function getArrivalsAtStop(stopId, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
  const [{ tripUpdates }, lookup] = await Promise.all([fetchTripUpdates(), getTripLookup()]);
  const now = Date.now();
  const predictions = [];

  for (const entity of tripUpdates) {
    if (TRIP_CANCELED.has(Number(entity.trip?.scheduleRelationship ?? 0))) continue;
    const tripId = entity.trip?.tripId || entity.tripProperties?.tripId || '';
    if (!tripId) continue;
    const tripInfo = lookup[tripId] ?? {
      tripId,
      routeId: entity.trip?.routeId ?? '',
      routeShortName: entity.trip?.routeId ?? tripId,
      headsign: '',
    };

    for (const update of entity.stopTimeUpdates) {
      if (update.stopId !== stopId || STOP_UNAVAILABLE.has(Number(update.scheduleRelationship ?? 0))) continue;
      const event = update.arrival ?? update.departure;
      if (!event || !Number.isFinite(Number(event.time))) continue;
      const arrivalMs = Number(event.time) * 1000;
      if (arrivalMs < now - 60_000) continue;
      predictions.push({
        id: `${tripId}-${update.stopId}-${Math.trunc(arrivalMs / 1000)}`,
        tripId,
        routeId: tripInfo.routeId || entity.trip?.routeId || '',
        routeShortName: tripInfo.routeShortName,
        headsign: tripInfo.headsign || `Към линия ${tripInfo.routeShortName}`,
        arrivalDate: new Date(arrivalMs).toISOString(),
        delaySeconds: event.delay ?? update.departure?.delay ?? null,
      });
    }
  }

  predictions.sort((a, b) => Date.parse(a.arrivalDate) - Date.parse(b.arrivalDate));
  return predictions.slice(0, limit);
}

export async function getArrivalsByStopCode(code, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
  const stopIds = await getStopIdsByCode(code);
  if (!stopIds.length) return { arrivals: [], count: 0 };
  const lists = await Promise.all(stopIds.map((id) => getArrivalsAtStop(id, { limit: limit * 2 })));
  const byId = new Map();
  for (const list of lists) for (const arrival of list) byId.set(arrival.id, arrival);
  const arrivals = [...byId.values()]
    .sort((a, b) => Date.parse(a.arrivalDate) - Date.parse(b.arrivalDate))
    .slice(0, limit);
  return { arrivals, count: arrivals.length };
}
