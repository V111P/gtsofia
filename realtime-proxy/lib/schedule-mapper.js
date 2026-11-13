/**
 * Surface timetable lookup for virtual boards.
 * The compact index is generated from the same GTFS/OSM pipeline as the site
 * schedules and is deployed with Render. It is used only when an exact RT
 * stop-time event is not available for the same trip and stop.
 */
const MAX_LOOKAHEAD_SECONDS = 2 * 60 * 60;
const PAST_GRACE_MS = 60_000;
const SOFIA_TIME_ZONE = 'Europe/Sofia';

function normalize(value) {
  return String(value ?? '').trim();
}

function localDateParts(timestampMs) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SOFIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    dateKey: `${values.year}-${values.month}-${values.day}`
  };
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function dateOffset(fromDateKey, toDateKey) {
  const [fromYear, fromMonth, fromDay] = fromDateKey.split('-').map(Number);
  const [toYear, toMonth, toDay] = toDateKey.split('-').map(Number);
  return Math.round((Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86_400_000);
}

function isServiceActive(calendar, serviceId, dateKey) {
  const referenceDate = normalize(calendar?.referenceDate);
  const hex = normalize(calendar?.serviceBits?.[serviceId]);
  if (!referenceDate || !hex) return false;
  const offset = dateOffset(referenceDate, dateKey);
  if (offset < 0 || offset >= Number(calendar?.coverageDays || 0)) return false;
  try {
    const bits = BigInt(`0x${hex}`);
    return (bits & (1n << BigInt(offset))) !== 0n;
  } catch {
    return false;
  }
}

function parseGtfsTime(value) {
  const match = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(normalize(value));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function getSofiaUtcOffsetMinutes(timestampMs) {
  const value = new Intl.DateTimeFormat('en-US', {
    timeZone: SOFIA_TIME_ZONE,
    timeZoneName: 'shortOffset'
  }).formatToParts(new Date(timestampMs)).find(part => part.type === 'timeZoneName')?.value || 'GMT+2';
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(value);
  if (!match) return 120;
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return match[1] === '-' ? -minutes : minutes;
}

function serviceTimeToEpoch(dateKey, seconds) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day) + seconds * 1000;
  return localAsUtc - getSofiaUtcOffsetMinutes(localAsUtc) * 60_000;
}

/** Pure helper exported for tests. */
export function extractScheduledArrivals(scheduleData, stopIdentifier, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const nowParts = localDateParts(nowMs);
  const requested = normalize(stopIdentifier);
  const stopIds = new Set((scheduleData?.stopIdsByIdentifier?.[requested] || []).map(normalize));
  if (!stopIds.size) return [];

  const serviceDates = [
    { dateKey: nowParts.dateKey, previousDay: false },
    { dateKey: shiftDateKey(nowParts.dateKey, -1), previousDay: true }
  ];
  const output = [];
  const seen = new Set();
  const maxTimestamp = nowMs + MAX_LOOKAHEAD_SECONDS * 1000;

  for (const route of Object.values(scheduleData?.routes || {})) {
    for (const [directionKey, direction] of Object.entries(route?.directions || {})) {
      const stopIndexes = [];
      (direction.stopIds || []).forEach((stopId, index) => {
        if (stopIds.has(normalize(stopId))) stopIndexes.push(index);
      });
      if (!stopIndexes.length) continue;

      for (const course of direction.courses || []) {
        const tripId = normalize(course.tripId);
        const serviceId = normalize(course.serviceId);
        if (!tripId || !serviceId) continue;

        for (const serviceDate of serviceDates) {
          if (!isServiceActive(scheduleData.calendar, serviceId, serviceDate.dateKey)) continue;

          for (const stopIndex of stopIndexes) {
            const rawTime = course.times?.[stopIndex];
            const seconds = parseGtfsTime(rawTime);
            if (seconds === null) continue;
            // The preceding service date contributes only after-midnight
            // 24:xx trips; ordinary same-clock times belong to today's service.
            if (serviceDate.previousDay && seconds < 24 * 60 * 60) continue;

            const timestampMs = serviceTimeToEpoch(serviceDate.dateKey, seconds);
            if (timestampMs < nowMs - PAST_GRACE_MS || timestampMs > maxTimestamp) continue;

            const arrivalId = `schedule|${tripId}|${direction.stopIds[stopIndex]}|${timestampMs}`;
            if (seen.has(arrivalId)) continue;
            seen.add(arrivalId);

            output.push({
              id: arrivalId,
              tripId,
              routeId: normalize(route.routeId),
              routeShortName: normalize(route.routeShortName),
              routeType: normalize(route.routeType),
              routeColor: normalize(route.routeColor),
              routeTextColor: normalize(route.routeTextColor),
              headsign: normalize(direction.headsign || direction.destination),
              destination: normalize(direction.destination),
              terminalStopId: normalize(direction.terminalStopId),
              stopId: normalize(direction.stopIds[stopIndex]),
              arrivalDate: new Date(timestampMs).toISOString(),
              delaySeconds: null,
              feedTimestamp: null,
              isRealtime: false,
              isScheduled: true,
              source: 'schedule',
              serviceDate: serviceDate.dateKey,
              directionKey
            });
          }
        }
      }
    }
  }

  output.sort((left, right) => Date.parse(left.arrivalDate) - Date.parse(right.arrivalDate));
  return output;
}

export function mergeRealtimeAndScheduledArrivals({
  realtimeArrivals = [],
  scheduledArrivals = [],
  updates = [],
  requestedStopIds = [],
  stopIdentifier = ''
} = {}) {
  const stopIds = new Set(requestedStopIds.map(normalize));
  const canceledTrips = new Set();
  const skippedTripStops = new Set();
  const explicitRealtimeTripStops = new Set();
  // RT and the site's static GTFS export can use different stop_id namespaces
  // (e.g. TM1247 vs 1247). Since this merge is for one requested public board,
  // use its canonical identifier to compare exact trip + board-stop pairs.
  const boardStopKey = normalize(stopIdentifier);
  const tripStopKey = (tripId, stopId) =>
    `${normalize(tripId)}|${boardStopKey || normalize(stopId)}`;

  for (const update of updates) {
    const tripId = normalize(update?.tripId);
    if (!tripId) continue;
    const tripRelationship = Number(update.tripScheduleRelationship ?? 0);
    // Cancellation applies to the entire trip; stop-level relationships apply
    // only to the exact trip + GTFS stop pair.
    if ([3, 6, 7].includes(tripRelationship)) canceledTrips.add(tripId);

    for (const stopUpdate of update.stopTimeUpdates || []) {
      const stopId = normalize(stopUpdate?.stopId);
      if (!stopIds.has(stopId)) continue;
      const key = tripStopKey(tripId, stopId);
      const relationship = Number(stopUpdate.scheduleRelationship ?? 0);
      if (relationship === 1) skippedTripStops.add(key); // SKIPPED
      if (relationship !== 1 && relationship !== 2) { // NO_DATA=2 leaves timetable fallback active
        const hasExplicitTime = Boolean(stopUpdate.arrival?.time || stopUpdate.departure?.time);
        if (hasExplicitTime) explicitRealtimeTripStops.add(key);
      }
    }
  }

  const realtimeTripStops = new Set(realtimeArrivals.map(arrival =>
    tripStopKey(arrival.tripId, arrival.stopId)).filter(key => key !== '|'));

  const scheduleFallback = scheduledArrivals.filter(arrival => {
    const tripId = normalize(arrival.tripId);
    const key = tripStopKey(tripId, arrival.stopId);
    if (!tripId || canceledTrips.has(tripId)) return false;
    if (skippedTripStops.has(key) || explicitRealtimeTripStops.has(key) || realtimeTripStops.has(key)) return false;
    return true;
  });

  const merged = [...realtimeArrivals, ...scheduleFallback];
  const unique = new Map();
  for (const arrival of merged) {
    const key = `${normalize(arrival.tripId)}|${normalize(arrival.stopId)}|${normalize(arrival.arrivalDate)}`;
    const previous = unique.get(key);
    // A realtime event always wins over a timetable event for the same trip/stop.
    if (!previous || arrival.isRealtime === true) unique.set(key, arrival);
  }

  return [...unique.values()]
    .sort((left, right) => Date.parse(left.arrivalDate) - Date.parse(right.arrivalDate));
}
