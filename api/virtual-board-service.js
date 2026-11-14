const routesData = require('../data/routes.json');
const directionsData = require('../data/directions.json');
const schedulesData = require('../data/schedules.json');
const stopsData = require('../data/stops.json');
const calendarData = require('../data/calendar.json');
const { getRouteMetadata } = require('../route-metadata');
const { buildStopIndexes, findPreferredStop } = require('../stop-utils');

const SOFIA_TIME_ZONE = 'Europe/Sofia';
const MAX_ARRIVALS_PER_LINE = 3;
const MAX_STATIC_LOOKAHEAD_SECONDS = 2 * 60 * 60;
const MAX_REALTIME_LOOKAHEAD_SECONDS = 2 * 60 * 60;
// Allow only minor feed/clock jitter after the predicted stop time.
const REALTIME_PAST_GRACE_SECONDS = 0;
// Application freshness policy. GTFS-Realtime recommends TripUpdate.timestamp
// but does not prescribe an expiry threshold; missing timestamps remain usable.
const MAX_TRIP_UPDATE_AGE_SECONDS = 120;
const MAX_TRIP_UPDATE_FUTURE_SKEW_SECONDS = 60;

function normalizeStopKey(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const withoutMetroPrefix = raw.replace(/^M/i, '');
  const digits = withoutMetroPrefix.replace(/\D/g, '');
  return digits ? String(Number(digits)) : withoutMetroPrefix.toLowerCase();
}

function stopIdsMatch(left, right) {
  const a = normalizeStopKey(left);
  return !!a && a === normalizeStopKey(right);
}

// GTFS identifiers are opaque strings. Use this exact comparison for all
// static/realtime entity references; stopIdsMatch is only a user-input alias
// fallback (for legacy stop-code lookups).
function gtfsIdsEqual(left, right) {
  const a = String(left ?? '').trim();
  return !!a && a === String(right ?? '').trim();
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDirectionText(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('bg-BG')
    .replace(/\s+/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/[.]/g, '')
    .trim();
}

function parseGtfsTime(value) {
  const match = String(value ?? '').trim().match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!match) return null;

  const [hour, minute, second] = match.slice(1).map(Number);
  if (minute > 59 || second > 59) return null;
  return hour * 3600 + minute * 60 + second;
}

function getSofiaDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SOFIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day'))
  };
}

function getSofiaDateKey(date) {
  const { year, month, day } = getSofiaDateParts(date);
  if (![year, month, day].every(Number.isFinite)) return '';

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getSofiaDateFromKey(value) {
  const raw = String(value ?? '').trim().replace(/-/g, '');
  if (!/^\d{8}$/.test(raw)) return null;

  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const parts = getSofiaDateParts(date);
  if (parts.year !== year || parts.month !== month || parts.day !== day) return null;
  return date;
}

function shiftSofiaDate(date, days) {
  const { year, month, day } = getSofiaDateParts(date);
  return new Date(Date.UTC(year, month - 1, day + days, 12));
}

function getSofiaOffsetMs(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SOFIA_TIME_ZONE,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const raw = parts.find(part => part.type === 'timeZoneName')?.value || 'GMT+0';
  const match = raw.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return 0;

  const sign = match[1] === '+' ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3] || 0)) * 60 * 1000;
}

function gtfsSecondsToServiceTimestamp(seconds, serviceDate) {
  const { year, month, day } = getSofiaDateParts(serviceDate);
  const wallClockUtc = Date.UTC(year, month - 1, day) + Number(seconds) * 1000;

  // The UTC offset can change during a GTFS service day (DST). Resolve the
  // offset at the target wall-clock instant rather than reusing midnight's
  // offset for every stop time.
  let timestamp = wallClockUtc - getSofiaOffsetMs(new Date(wallClockUtc));
  for (let attempt = 0; attempt < 3; attempt++) {
    const corrected = wallClockUtc - getSofiaOffsetMs(new Date(timestamp));
    if (corrected === timestamp) break;
    timestamp = corrected;
  }
  return timestamp / 1000;
}

function getScheduleDayType(date, calendar = calendarData) {
  const dateKey = getSofiaDateKey(date);
  const configured = calendar?.dateTypes?.[dateKey]
    || calendar?.config?.dateOverrides?.[dateKey];
  if (configured === 'weekday' || configured === 'weekend') return configured;

  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: SOFIA_TIME_ZONE,
    weekday: 'short'
  }).format(date);
  return weekday === 'Sat' || weekday === 'Sun' ? 'weekend' : 'weekday';
}

function isServiceActive(serviceId, date, calendar = calendarData) {
  const id = String(serviceId ?? '').trim();
  if (!id) return true;

  const dateKey = getSofiaDateKey(date);
  const byDate = calendar?.serviceIdsByDate;
  if (byDate && typeof byDate === 'object') {
    const ids = byDate[dateKey];
    return Array.isArray(ids) && ids.some(value => String(value).trim() === id);
  }

  const compactDate = dateKey.replaceAll('-', '');
  const weekdayField = new Intl.DateTimeFormat('en-US', {
    timeZone: SOFIA_TIME_ZONE,
    weekday: 'long'
  }).format(date).toLowerCase();
  const pattern = (calendar?.servicePatterns || []).find(row => String(row?.service_id || '').trim() === id);
  let active = false;

  if (pattern) {
    active = compactDate >= String(pattern.start_date || '')
      && compactDate <= String(pattern.end_date || '')
      && String(pattern[weekdayField] || '') === '1';
  }

  for (const exception of calendar?.exceptions || []) {
    if (
      String(exception?.service_id || '').trim() === id
      && String(exception?.date || '').trim() === compactDate
    ) {
      if (String(exception.exception_type) === '1') active = true;
      if (String(exception.exception_type) === '2') active = false;
    }
  }

  return active;
}

function createRouteMetadata(route) {
  return getRouteMetadata(route);
}

function createDataContext(data = {}) {
  const routes = data.routes || routesData;
  const directions = data.directions || directionsData;
  const schedules = data.schedules || schedulesData;
  const stops = data.stops || stopsData;
  const calendar = data.calendar || calendarData;

  const routeById = new Map(routes.map(route => [String(route.route_id), route]));
  // Match the Python generator's deterministic preference when GTFS contains
  // duplicate stop_id / stop_code records. Never rely on input row order.
  const { byId: stopById, byCode: stopByCode } = buildStopIndexes(stops);

  // Index each route-direction by its served stops once at service startup.
  // Board requests then visit only routes serving the selected stop instead
  // of rescanning every route, direction and pattern on every board request.
  const directionsByStop = new Map();
  for (const route of routes) {
    const routeId = String(route?.route_id || '').trim();
    if (!routeId) continue;

    const routeDirections = directions?.[routeId] || {};
    for (const [directionKey, direction] of Object.entries(routeDirections)) {
      const pattern = Array.isArray(direction?.pattern) ? direction.pattern.map(String) : [];
      if (!pattern.length) continue;

      for (let stopIndex = 0; stopIndex < pattern.length; stopIndex++) {
        const stopKey = String(pattern[stopIndex] || '').trim();
        if (!stopKey) continue;

        if (!directionsByStop.has(stopKey)) directionsByStop.set(stopKey, []);
        directionsByStop.get(stopKey).push({
          route,
          routeId,
          routeIsMetro: String(route.route_type) === '1',
          directionKey,
          direction,
          pattern,
          stopIndex,
          daySchedules: schedules?.[routeId]?.[directionKey] || {},
          meta: createRouteMetadata(route)
        });
      }
    }
  }

  function getStop(stopId) {
    const raw = String(stopId ?? '').trim();
    return stopById.get(raw)
      || stopByCode.get(raw)
      || findPreferredStop(
        stops,
        stop => stopIdsMatch(stop?.stop_id, raw) || stopIdsMatch(stop?.stop_code, raw)
      )
      || null;
  }

  function getDestinationName(stopId, direction, fallback = '') {
    const stop = getStop(stopId);
    const directionStops = Array.isArray(direction?.stops) ? direction.stops : [];
    const directionStop = stopId
      ? directionStops.find(item => gtfsIdsEqual(item?.stop_id, stopId))
      : directionStops[directionStops.length - 1];

    const osmName = String(
      stop?.osm_stop_name
      || directionStop?.osm_name
      || (stop?.stop_name_source === 'osm' ? stop?.stop_name : '')
      || ''
    ).trim();
    if (osmName) return osmName;

    // The direction headsign describes the full route pattern, not necessarily
    // the terminal of an individual short-turn trip. When the terminal stop has
    // no OSM name, prefer its GTFS stop name before falling back to that headsign.
    const stopName = String(
      stop?.stop_name
      || directionStop?.name
      || directionStop?.gtfs_name
      || ''
    ).trim();
    if (stopName) return stopName;

    return String(
      direction?.destination
      || direction?.headsign
      || fallback
      || ''
    ).trim();
  }

  function findDirection(routeId, stopId, destination = '', directionId = '') {
    const routeDirections = directions?.[String(routeId)] || {};
    const candidates = Object.entries(routeDirections)
      .filter(([, direction]) => Array.isArray(direction?.pattern)
        && direction.pattern.some(id => gtfsIdsEqual(id, stopId)))
      .map(([key, direction]) => ({ key, ...direction }));

    if (!candidates.length) return null;
    const wantedDestination = normalizeDirectionText(destination);
    if (wantedDestination) {
      const match = candidates.find(direction => normalizeDirectionText(direction.headsign || direction.destination) === wantedDestination);
      if (match) return match;
    }

    const wantedDirectionId = String(directionId ?? '').trim();
    if (wantedDirectionId) {
      const match = candidates.find(direction => String(direction.direction_id ?? direction.key ?? '').trim() === wantedDirectionId);
      if (match) return match;
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  function makeStaticScheduleInfo(routeId, directionKey, schedule) {
    const direction = directions?.[String(routeId)]?.[directionKey];
    if (!direction) return null;

    const pattern = Array.isArray(direction.pattern) ? direction.pattern.map(String) : [];
    if (!pattern.length) return null;

    const times = Array.isArray(schedule?.times) ? schedule.times : [];
    let terminalIndex = -1;
    for (let index = Math.min(times.length, pattern.length) - 1; index >= 0; index--) {
      if (parseGtfsTime(times[index]) !== null) {
        terminalIndex = index;
        break;
      }
    }

    const terminalStopId = terminalIndex >= 0 ? String(pattern[terminalIndex] || '').trim() : '';
    if (!terminalStopId) return null;

    return {
      routeId: String(routeId),
      directionKey,
      direction: { key: directionKey, ...direction },
      schedule,
      terminalIndex,
      terminalStopId
    };
  }

  function findStaticScheduleInfo(routeId, originalTripId, dayType, serviceDate = null) {
    const wantedTripId = String(originalTripId ?? '').trim();
    if (!wantedTripId) return null;

    // trip_id is globally unique in a static GTFS feed. route_id is optional
    // when trip_id is present, so search all routes when the producer omits it
    // and require exactly one matching static trip instead of taking first row.
    const routeIds = routeId ? [String(routeId)] : Object.keys(schedules || {});
    const dayOrder = [dayType, dayType === 'weekday' ? 'weekend' : 'weekday'];

    for (const currentDayType of dayOrder) {
      const matches = [];
      for (const currentRouteId of routeIds) {
        const routeSchedules = schedules?.[currentRouteId] || {};
        for (const [directionKey, daySchedules] of Object.entries(routeSchedules)) {
          const rows = Array.isArray(daySchedules?.[currentDayType]) ? daySchedules[currentDayType] : [];
          for (const schedule of rows) {
            if (String(schedule?.original_trip_id ?? '').trim() !== wantedTripId) continue;
            const direction = directions?.[currentRouteId]?.[directionKey];
            const serviceId = String(schedule?.service_id || direction?.service_id || '').trim();
            if (serviceId && serviceDate instanceof Date && !isServiceActive(serviceId, serviceDate, calendar)) continue;
            const info = makeStaticScheduleInfo(currentRouteId, directionKey, schedule);
            if (info) {
              info.serviceDate = serviceDate instanceof Date ? serviceDate : null;
              matches.push(info);
            }
          }
        }
      }
      if (matches.length) return resolveUniqueStaticScheduleMatch(matches);
    }

    return null;
  }

  function resolveUniqueStaticScheduleMatch(matches) {
    if (!Array.isArray(matches) || !matches.length) return null;
    const uniqueCourses = new Set(matches.map(item => [
      String(item.routeId || ''),
      String(item.directionKey || ''),
      String(item.schedule?.original_trip_id ?? '').trim(),
      String(item.schedule?.start_time ?? '').trim()
    ].join('|')));
    return uniqueCourses.size === 1 ? matches[0] : null;
  }

  function findStaticScheduleInfoByStartTime(routeId, startTime, directionId, serviceDate) {
    const wantedRouteId = String(routeId ?? '').trim();
    const wantedStartTime = String(startTime ?? '').trim();
    const wantedDirectionId = String(directionId ?? '').trim();
    if (!wantedRouteId || !wantedStartTime) return null;

    const dayType = getScheduleDayType(serviceDate, calendar);
    const routeSchedules = schedules?.[wantedRouteId] || {};
    const dayOrder = [dayType, dayType === 'weekday' ? 'weekend' : 'weekday'];

    for (const currentDayType of dayOrder) {
      const matches = [];
      for (const [directionKey, daySchedules] of Object.entries(routeSchedules)) {
        const direction = directions?.[wantedRouteId]?.[directionKey];
        if (!direction) continue;
        const actualDirectionId = String(direction.direction_id ?? '').trim();
        if (actualDirectionId !== wantedDirectionId) continue;

        const rows = Array.isArray(daySchedules?.[currentDayType]) ? daySchedules[currentDayType] : [];
        for (const schedule of rows) {
          if (String(schedule?.start_time ?? '').trim() !== wantedStartTime) continue;
          const serviceId = String(schedule?.service_id || direction?.service_id || '').trim();
          if (serviceId && serviceDate instanceof Date && !isServiceActive(serviceId, serviceDate, calendar)) continue;
          const info = makeStaticScheduleInfo(wantedRouteId, directionKey, schedule);
          if (info) {
            info.serviceDate = serviceDate;
            matches.push(info);
          }
        }
      }

      if (matches.length) return resolveUniqueStaticScheduleMatch(matches);
    }
    return null;
  }

  function findStaticScheduleInfoForRealtime(routeId, tripId, startTime, directionId, startDate, now) {
    const wantedRouteId = String(routeId ?? '').trim();
    const wantedTripId = String(tripId ?? '').trim();
    const wantedStartTime = String(startTime ?? '').trim();
    const wantedDirectionId = String(directionId ?? '').trim();
    const wantedDate = normalizeServiceDate(startDate);
    const serviceDate = wantedDate ? getSofiaDateFromKey(wantedDate) : new Date(now);
    if (!serviceDate) return null;

    // A descriptor with an explicit previous service date can legitimately
    // refer to a trip whose GTFS time is 24:00 or later and is still running
    // after midnight. Limit matching to the current or immediately previous
    // service date; older instances are outside this board's look-ahead model.
    const dateDelta = Math.round((Date.UTC(
      getSofiaDateParts(serviceDate).year,
      getSofiaDateParts(serviceDate).month - 1,
      getSofiaDateParts(serviceDate).day
    ) - Date.UTC(
      getSofiaDateParts(now).year,
      getSofiaDateParts(now).month - 1,
      getSofiaDateParts(now).day
    )) / 86400000);
    if (dateDelta > 0 || dateDelta < -1) return null;

    // GTFS-Realtime requires start_date to disambiguate a trip that runs past
    // 24 hours. Do not guess the service date for such a descriptor.
    const startSeconds = parseGtfsTime(wantedStartTime);
    if (!wantedDate && startSeconds !== null && startSeconds >= 24 * 60 * 60) return null;

    const dayType = getScheduleDayType(serviceDate, calendar);
    if (wantedTripId) {
      const exactMatch = findStaticScheduleInfo(wantedRouteId, wantedTripId, dayType, serviceDate);
      if (!exactMatch) return null;
      if (wantedStartTime
        && String(exactMatch.schedule?.start_time || '').trim() !== wantedStartTime) return null;
      if (!wantedDate && parseGtfsTime(exactMatch.schedule?.start_time) >= 24 * 60 * 60) return null;
      const matchedDirectionId = String(exactMatch.direction?.direction_id ?? '').trim();
      if (wantedDirectionId && matchedDirectionId !== wantedDirectionId) return null;
      return exactMatch;
    }

    // Without trip_id, GTFS-Realtime requires route_id, direction_id,
    // start_time and start_date to identify one scheduled trip instance.
    if (!wantedRouteId || !wantedStartTime || !wantedDirectionId || !wantedDate) return null;

    return findStaticScheduleInfoByStartTime(
      wantedRouteId,
      wantedStartTime,
      wantedDirectionId,
      serviceDate
    );
  }

  function getRealtimeUpdateStopIndex(update, staticInfo) {
    const pattern = Array.isArray(staticInfo?.direction?.pattern)
      ? staticInfo.direction.pattern.map(String)
      : [];
    const sequences = Array.isArray(staticInfo?.schedule?.stop_sequences)
      ? staticInfo.schedule.stop_sequences
      : [];

    // stop_sequence is the authoritative reference when supplied. Never fall
    // back to stop_id if a supplied sequence cannot be resolved: that could
    // attach a prediction to the wrong occurrence on a loop route.
    const sequence = optionalFiniteNumber(update?.stop_sequence);
    if (sequence !== null) {
      const sequenceIndex = sequences.findIndex(value => Number(value) === sequence);
      if (sequenceIndex < 0 || sequenceIndex >= pattern.length) return -1;
      const stopId = String(update?.stop_id || '').trim();
      // GTFS IDs are opaque, case-sensitive strings. Do not normalize
      // leading zeroes or aliases when validating a realtime stop reference.
      if (stopId && String(pattern[sequenceIndex]).trim() !== stopId) return -1;
      return sequenceIndex;
    }

    const stopId = String(update?.stop_id || '').trim();
    if (!stopId) return -1;
    const matches = [];
    for (let index = 0; index < pattern.length; index++) {
      if (String(pattern[index]).trim() === stopId) matches.push(index);
    }
    // stop_id alone is only safe when it identifies one occurrence.
    return matches.length === 1 ? matches[0] : -1;
  }

  function getRealtimeEvent(update, preferDeparture = false) {
    const arrival = update?.arrival || null;
    const departure = update?.departure || null;
    const hasTiming = event => event
      && (optionalFiniteNumber(event.timestamp) !== null
        || optionalFiniteNumber(event.delay) !== null);

    const preferred = preferDeparture ? departure : arrival;
    const secondary = preferDeparture ? arrival : departure;
    if (hasTiming(preferred)) return preferred;
    if (hasTiming(secondary)) return secondary;
    return null;
  }

  function getTripRelationship(realtimeTrip) {
    const name = String(realtimeTrip?.schedule_relationship_name || '').trim().toUpperCase();
    const numeric = optionalFiniteNumber(realtimeTrip?.schedule_relationship);
    const byNumber = ({
      0: 'SCHEDULED',
      1: 'ADDED',
      2: 'UNSCHEDULED',
      3: 'CANCELED',
      5: 'REPLACEMENT',
      6: 'DUPLICATED',
      7: 'DELETED',
      8: 'NEW'
    })[numeric];
    if (name && byNumber && name !== byNumber) return 'INVALID_RELATIONSHIP';
    if (name) return name;
    return byNumber || (numeric === null ? 'SCHEDULED' : `UNKNOWN_${numeric}`);
  }

  function isTripUpdateFresh(realtimeTrip, now) {
    const updatedAt = optionalFiniteNumber(realtimeTrip?.trip_update_timestamp);
    if (updatedAt === null) return true;

    const age = now.getTime() / 1000 - updatedAt;
    return age <= MAX_TRIP_UPDATE_AGE_SECONDS
      && age >= -MAX_TRIP_UPDATE_FUTURE_SKEW_SECONDS;
  }

  function getMappedStopTimeUpdates(realtimeTrip, staticInfo) {
    const source = Array.isArray(realtimeTrip?.stop_time_updates)
      ? realtimeTrip.stop_time_updates
      : [];
    if (!source.length) return { valid: false, updates: [], reason: 'missing-stop-time-updates' };

    const updates = [];
    let previousStopIndex = -1;
    for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex++) {
      const update = source[sourceIndex];
      const stopIndex = getRealtimeUpdateStopIndex(update, staticInfo);
      if (stopIndex < 0) {
        return { valid: false, updates: [], reason: 'unmapped-stop-time-update' };
      }
      // The GTFS-Realtime reference requires updates to follow stop_sequence;
      // repeated or out-of-order stops make propagation ambiguous.
      if (stopIndex <= previousStopIndex) {
        return { valid: false, updates: [], reason: 'unordered-stop-time-updates' };
      }
      previousStopIndex = stopIndex;

      const relationship = optionalFiniteNumber(update?.schedule_relationship) ?? 0;
      if (![0, 1, 2].includes(relationship)) {
        return { valid: false, updates: [], reason: 'unsupported-stop-relationship' };
      }
      const arrival = update?.arrival ?? null;
      const departure = update?.departure ?? null;
      const events = [arrival, departure].filter(event => event !== null);
      const hasScheduledTime = events.some(
        event => optionalFiniteNumber(event?.scheduled_time) !== null
      );
      if (hasScheduledTime) {
        // StopTimeEvent.scheduled_time is forbidden for SCHEDULED TripUpdates.
        return { valid: false, updates: [], reason: 'scheduled-time-for-scheduled-trip' };
      }
      if (events.some(event => optionalFiniteNumber(event?.timestamp) === null
        && optionalFiniteNumber(event?.delay) === null)) {
        // Each supplied StopTimeEvent needs either absolute time or delay.
        return { valid: false, updates: [], reason: 'stop-time-event-without-time-or-delay' };
      }
      if (relationship === 0 && !events.length) {
        // A SCHEDULED StopTimeUpdate needs arrival or departure.
        return { valid: false, updates: [], reason: 'scheduled-update-without-event' };
      }
      const hasStaticArrival = Array.isArray(staticInfo.schedule?.has_arrival)
        ? staticInfo.schedule.has_arrival[stopIndex] === true
        : null;
      const hasStaticDeparture = Array.isArray(staticInfo.schedule?.has_departure)
        ? staticInfo.schedule.has_departure[stopIndex] === true
        : null;
      if (relationship === 0 && hasStaticArrival === true && hasStaticDeparture === true
        && (!arrival || !departure)) {
        // GTFS-Realtime requires both StopTimeEvents when static GTFS has
        // both arrival_time and departure_time for this stop.
        return { valid: false, updates: [], reason: 'scheduled-update-missing-arrival-or-departure' };
      }
      if (relationship === 2 && (events.length
        || optionalFiniteNumber(update?.arrival?.uncertainty) !== null
        || optionalFiniteNumber(update?.departure?.uncertainty) !== null)) {
        // For a SCHEDULED TripUpdate, NO_DATA must not contain arrival or
        // departure messages at all (including empty event messages).
        return { valid: false, updates: [], reason: 'no-data-with-timing' };
      }

      updates.push({ update, sourceIndex, stopIndex, relationship });
    }

    return { valid: true, updates, reason: '' };
  }

  function getRealtimeEventType(update, event) {
    return update?.arrival === event ? 'arrival' : 'departure';
  }

  function getScheduledSecondsForEvent(schedule, stopIndex, eventType = 'departure') {
    if (eventType === 'arrival') {
      if (Array.isArray(schedule?.has_arrival) && schedule.has_arrival[stopIndex] !== true) return null;
      const arrival = Array.isArray(schedule?.arrival_times)
        ? parseGtfsTime(schedule.arrival_times[stopIndex])
        : null;
      return arrival ?? (Array.isArray(schedule?.has_arrival) ? null : parseGtfsTime(schedule?.times?.[stopIndex]));
    }

    if (Array.isArray(schedule?.has_departure) && schedule.has_departure[stopIndex] !== true) return null;
    return parseGtfsTime(schedule?.times?.[stopIndex]);
  }

  function getRealtimeEventDelay(event, stopIndex, schedule, serviceDate, eventType = 'departure') {
    // StopTimeEvent.time is authoritative when both time and delay are set.
    // Compare it with the matching static event (arrival vs departure).
    const timestamp = optionalFiniteNumber(event?.timestamp);
    if (timestamp !== null) {
      const scheduledSeconds = getScheduledSecondsForEvent(schedule, stopIndex, eventType);
      if (scheduledSeconds === null) return null;
      const scheduledTimestamp = gtfsSecondsToServiceTimestamp(scheduledSeconds, serviceDate);
      return timestamp - scheduledTimestamp;
    }

    return optionalFiniteNumber(event?.delay);
  }

  function resolveScheduledTripAtStop(realtimeTrip, staticInfo, selectedStopId, now, requestedStopIndex = null) {
    const relationship = getTripRelationship(realtimeTrip);

    // Relationship states describe the trip's service status. In a fresh full
    // feed, keep CANCELED/DELETED/REPLACEMENT semantics even if the optional
    // prediction timestamp is old; the timestamp freshness policy applies to
    // timing predictions, not to the presence of the current entity.
    if (relationship === 'CANCELED') {
      return { state: 'cancelled', suppressStatic: true, reason: 'trip-canceled' };
    }
    if (relationship === 'DELETED') {
      return { state: 'deleted', suppressStatic: true, reason: 'trip-deleted' };
    }
    if (relationship === 'REPLACEMENT') {
      // Static GTFS must not be used for the replaced instance. The replacement
      // itself is shown only when its complete stop predictions can be mapped.
      return { state: 'replaced', suppressStatic: true, reason: 'trip-replaced' };
    }
    if (relationship !== 'SCHEDULED') {
      return { state: 'unsupported', suppressStatic: false, reason: 'non-scheduled-trip' };
    }
    if (!isTripUpdateFresh(realtimeTrip, now)) {
      return { state: 'stale', suppressStatic: false, reason: 'stale-trip-update' };
    }
    if (!staticInfo) {
      return { state: 'invalid', suppressStatic: false, reason: 'static-trip-not-found' };
    }

    const pattern = Array.isArray(staticInfo.direction?.pattern)
      ? staticInfo.direction.pattern.map(String)
      : [];
    const targetIndex = Number.isInteger(requestedStopIndex)
      ? requestedStopIndex
      : pattern.findIndex(id => gtfsIdsEqual(id, selectedStopId));
    if (targetIndex < 0 || targetIndex >= pattern.length
      || !gtfsIdsEqual(pattern[targetIndex], selectedStopId)
      || targetIndex > staticInfo.terminalIndex) {
      return { state: 'unknown', suppressStatic: false, reason: 'target-stop-not-in-trip' };
    }

    const mapped = getMappedStopTimeUpdates(realtimeTrip, staticInfo);
    if (!mapped.valid) {
      return { state: 'invalid', suppressStatic: false, reason: mapped.reason };
    }

    let propagatedDelay = optionalFiniteNumber(realtimeTrip?.trip_delay);
    let propagatedUncertainty = null;
    let propagatedFrom = propagatedDelay === null ? '' : 'trip-delay';
    let targetUpdate = null;
    let targetEventType = 'arrival';
    let targetSkipped = false;
    let targetNoData = false;
    let downstreamTiming = false;

    for (const item of mapped.updates) {
      if (item.stopIndex > targetIndex) {
        if (getRealtimeEvent(item.update, true)) downstreamTiming = true;
        continue;
      }

      const isTargetStop = item.stopIndex === targetIndex;
      if (item.relationship === 2) { // NO_DATA clears propagation from this stop onward.
        propagatedDelay = null;
        propagatedUncertainty = null;
        propagatedFrom = 'no-data';
        if (isTargetStop) targetNoData = true;
        continue;
      }

      if (item.relationship === 1) { // SKIPPED does not clear prior delay.
        if (isTargetStop) targetSkipped = true;
        continue;
      }

      const event = getRealtimeEvent(item.update, !isTargetStop);
      const eventType = event ? getRealtimeEventType(item.update, event) : 'departure';
      const eventDelay = event
        ? getRealtimeEventDelay(event, item.stopIndex, staticInfo.schedule, staticInfo.serviceDate || now, eventType)
        : null;

      // A SCHEDULED update supersedes inherited TripUpdate.delay. If its event
      // is malformed/unusable, clear the inherited estimate instead of carrying
      // it through a point where the producer supplied a newer update.
      propagatedDelay = eventDelay;
      propagatedUncertainty = eventDelay === null
        ? null
        : optionalFiniteNumber(event?.uncertainty);
      propagatedFrom = eventDelay === null ? 'unknown' : (isTargetStop ? 'target-update' : 'upstream-update');
      if (isTargetStop) {
        targetUpdate = event;
        targetEventType = eventType;
      }
    }

    if (targetSkipped) {
      return { state: 'skipped', suppressStatic: true, reason: 'stop-skipped' };
    }
    if (targetNoData) {
      return { state: 'no-data', suppressStatic: false, reason: 'stop-no-data' };
    }

    const targetScheduledSeconds = getScheduledSecondsForEvent(
      staticInfo.schedule,
      targetIndex,
      targetEventType
    );
    const targetScheduledTimestamp = targetScheduledSeconds === null
      ? null
      : gtfsSecondsToServiceTimestamp(targetScheduledSeconds, staticInfo.serviceDate || now);
    let timestamp = optionalFiniteNumber(targetUpdate?.timestamp);
    if (timestamp === null && propagatedDelay !== null && targetScheduledTimestamp !== null) {
      timestamp = targetScheduledTimestamp + propagatedDelay;
    }
    if (timestamp === null) {
      return {
        state: downstreamTiming ? 'downstream-only' : (propagatedFrom === 'no-data' ? 'no-data' : 'no-update'),
        suppressStatic: false,
        reason: downstreamTiming ? 'future-stop-only' : 'no-prediction-for-stop'
      };
    }

    const nowTimestamp = now.getTime() / 1000;
    if (timestamp < nowTimestamp - REALTIME_PAST_GRACE_SECONDS) {
      return {
        state: 'passed',
        suppressStatic: true,
        timestamp,
        scheduled_time: targetScheduledTimestamp,
        event_type: targetEventType,
        delay: propagatedDelay,
        uncertainty: propagatedUncertainty,
        reason: 'predicted-time-passed'
      };
    }

    return {
      state: 'prediction',
      suppressStatic: true,
      timestamp,
      scheduled_time: targetScheduledTimestamp,
      event_type: targetEventType,
      delay: propagatedDelay,
      uncertainty: propagatedUncertainty,
      reason: propagatedFrom || 'stop-time-update'
    };
  }

  function buildRealtimeRouteFromTripUpdate(realtimeTrip, selectedStopId, now) {
    const relationship = getTripRelationship(realtimeTrip);
    if (relationship !== 'SCHEDULED' || !isTripUpdateFresh(realtimeTrip, now)) return null;

    const realtimeDate = normalizeServiceDate(
      realtimeTrip?.trip_start_date || realtimeTrip?.start_date
    );

    const originalTripId = String(realtimeTrip?.trip_id || '').trim();
    const routeIdHint = String(realtimeTrip?.route_id || '').trim();
    const realtimeStartTime = String(realtimeTrip?.trip_start_time || realtimeTrip?.start_time || '').trim();
    const directionId = String(realtimeTrip?.direction_id || '').trim();

    const staticInfo = findStaticScheduleInfoForRealtime(
      routeIdHint,
      originalTripId,
      realtimeStartTime,
      directionId,
      realtimeDate,
      now
    );
    if (!staticInfo) return null;

    const canonicalTripId = String(staticInfo.schedule?.original_trip_id || originalTripId).trim();
    const producerTripId = originalTripId && originalTripId !== canonicalTripId
      ? originalTripId
      : '';
    const staticStartTime = String(staticInfo.schedule?.start_time || '').trim();
    if (realtimeStartTime && staticStartTime && realtimeStartTime !== staticStartTime) return null;

    const staticDirectionId = String(staticInfo.direction?.direction_id ?? '').trim();
    const pattern = Array.isArray(staticInfo.direction?.pattern)
      ? staticInfo.direction.pattern.map(String)
      : [];
    const targetIndexes = [];
    for (let index = 0; index <= staticInfo.terminalIndex && index < pattern.length; index++) {
      if (gtfsIdsEqual(pattern[index], selectedStopId)) targetIndexes.push(index);
    }

    const resolvedTimes = [];
    for (const targetIndex of targetIndexes) {
      const resolution = resolveScheduledTripAtStop(
        realtimeTrip,
        staticInfo,
        selectedStopId,
        now,
        targetIndex
      );
      if (resolution.state !== 'prediction') continue;
      if (resolution.timestamp > now.getTime() / 1000 + MAX_REALTIME_LOOKAHEAD_SECONDS) continue;

      resolvedTimes.push({
        timestamp: resolution.timestamp,
        delay: resolution.delay,
        scheduled: false,
        source: 'realtime',
        scheduled_time: resolution.scheduled_time ?? null,
        event_type: resolution.event_type || 'departure',
        route_id: String(staticInfo.routeId || routeIdHint).trim(),
        trip_id: canonicalTripId,
        realtime_trip_id: producerTripId,
        trip_start_date: realtimeDate || normalizeServiceDate(getSofiaDateKey(staticInfo.serviceDate || now)),
        trip_start_time: staticStartTime || realtimeStartTime,
        direction_id: staticDirectionId,
        uncertainty: resolution.uncertainty,
        stop_schedule_relationship: 0,
        stop_schedule_relationship_name: 'SCHEDULED'
      });
    }
    if (!resolvedTimes.length) return null;

    const routeId = String(staticInfo.routeId || routeIdHint).trim();
    const route = routeById.get(routeId);
    if (!routeId || !route) return null;

    const meta = createRouteMetadata(route) || {
      id: routeId,
      number: String(route.route_short_name || '—'),
      type: 'bus',
      subtype: '',
      icon: '',
      color: '#BE1E2D',
      textColor: '#FFFFFF'
    };
    const destination = getDestinationName(
      staticInfo.terminalStopId,
      staticInfo.direction,
      staticInfo.direction?.destination || staticInfo.direction?.headsign || staticInfo.terminalStopId
    );

    return {
      route_id: routeId,
      trip_id: canonicalTripId,
      realtime_trip_id: producerTripId,
      trip_start_date: realtimeDate,
      trip_start_time: staticStartTime || realtimeStartTime,
      route_ref: meta.number,
      meta,
      direction_key: staticInfo.directionKey,
      direction_id: staticDirectionId,
      terminal_stop_id: staticInfo.terminalStopId,
      destination_stop_id: staticInfo.terminalStopId,
      destination,
      realtime: true,
      scheduled: false,
      source: 'realtime',
      times: resolvedTimes
    };
  }

  function isSkipped(schedule, routeId, stopId, stopIndex, skippedTrips, pattern) {
    const originalTripId = String(schedule?.original_trip_id || '').trim();
    const stopSequence = optionalFiniteNumber(schedule?.stop_sequences?.[stopIndex]);
    const patternStopId = String(pattern?.[stopIndex] ?? '').trim();

    return skippedTrips.some(skipped => {
      if (!skipped) return false;
      if (String(skipped.route_id || '').trim() !== String(routeId).trim()) return false;

      const skippedStopId = String(skipped.stop_id || '').trim();
      const skippedSequence = optionalFiniteNumber(skipped.stop_sequence);
      if (skippedSequence !== null) {
        // stop_sequence identifies one visit, even when a loop route visits
        // the same stop_id more than once. If both fields exist, both must agree.
        if (stopSequence === null || skippedSequence !== stopSequence) return false;
        if (skippedStopId && !gtfsIdsEqual(skippedStopId, patternStopId)) return false;
      } else {
        // A stop_id-only SKIPPED update is safe only when that ID occurs once
        // in the scheduled trip. Otherwise it cannot identify a specific visit.
        if (!skippedStopId || !gtfsIdsEqual(skippedStopId, patternStopId)) return false;
        if (pattern.filter(id => gtfsIdsEqual(id, skippedStopId)).length !== 1) return false;
      }

      return !!originalTripId && String(skipped.trip_id || '').trim() === originalTripId;
    });
  }

  function getStaticArrivals(stopId, isMetro, skippedTrips, now) {
    const nowTimestamp = now.getTime() / 1000;
    const result = [];
    const serviceStatus = new Map();
    const candidates = directionsByStop.get(String(stopId || '').trim()) || [];
    const serviceDates = [shiftSofiaDate(now, -1), new Date(now)];

    function serviceIsActive(serviceId, serviceDate) {
      const id = String(serviceId || '').trim();
      if (!id) return true;
      const cacheKey = `${normalizeServiceDate(getSofiaDateKey(serviceDate))}|${id}`;
      if (!serviceStatus.has(cacheKey)) {
        serviceStatus.set(cacheKey, isServiceActive(id, serviceDate, calendar));
      }
      return serviceStatus.get(cacheKey);
    }

    for (const candidate of candidates) {
      if (candidate.routeIsMetro !== isMetro) continue;

      const {
        routeId,
        directionKey,
        direction,
        pattern,
        stopIndex,
        daySchedules,
        meta
      } = candidate;
      for (const serviceDate of serviceDates) {
        const dayType = getScheduleDayType(serviceDate, calendar);
        const dayRows = daySchedules?.[dayType];
        if (!Array.isArray(dayRows)) continue;

        for (const schedule of dayRows) {
          const serviceId = String(schedule?.service_id || direction?.service_id || '').trim();
          if (!serviceIsActive(serviceId, serviceDate)) continue;

          const seconds = parseGtfsTime(
            schedule?.arrival_times?.[stopIndex] ?? schedule?.times?.[stopIndex]
          );
          if (seconds == null) continue;

          const times = Array.isArray(schedule?.times) ? schedule.times : [];
        let terminalIndex = -1;
        for (let index = Math.min(times.length, pattern.length) - 1; index >= 0; index--) {
          if (parseGtfsTime(times[index]) != null) {
            terminalIndex = index;
            break;
          }
        }
        if (terminalIndex < stopIndex) continue;

        const terminalStopId = String(pattern[terminalIndex] || '').trim();
        if (!terminalStopId || isSkipped(schedule, routeId, stopId, stopIndex, skippedTrips, pattern)) continue;

        // A timetable trip must not be shown at the stop where that exact
        // trip ends. The last populated time identifies the terminal for
        // both full-length and partial (short-turn) trips.
        if (gtfsIdsEqual(terminalStopId, stopId)) continue;

        const timestamp = gtfsSecondsToServiceTimestamp(seconds, serviceDate);
        if (timestamp < nowTimestamp) continue;
        if (timestamp > nowTimestamp + MAX_STATIC_LOOKAHEAD_SECONDS) continue;

        result.push({
          route_id: routeId,
          direction_key: directionKey,
          direction_id: String(direction?.direction_id ?? '').trim(),
          terminal_stop_id: terminalStopId,
          destination: getDestinationName(
            terminalStopId,
            direction,
            direction?.destination || direction?.headsign || terminalStopId
          ),
          route_ref: meta?.number || candidate.route.route_short_name || '—',
          meta,
          original_trip_id: String(schedule?.original_trip_id || '').trim(),
          stop_index: stopIndex,
          stop_sequence: optionalFiniteNumber(schedule?.stop_sequences?.[stopIndex]),
          static_trip_id: String(schedule?.trip_id ?? '').trim(),
          trip_start_time: String(schedule?.start_time || '').trim(),
          trip_start_date: normalizeServiceDate(getSofiaDateKey(serviceDate)),
          times: [{
            timestamp,
            delay: null,
            scheduled: true,
            source: 'static',
            // Keep the identity on each arrival, not only on the route row.
            // mergeRoutes can combine several trips serving the same
            // destination; the browser needs to distinguish the exact trip
            // whose realtime prediction it previously showed.
            route_id: routeId,
            trip_id: String(schedule?.original_trip_id || '').trim(),
            trip_start_date: normalizeServiceDate(getSofiaDateKey(serviceDate)),
            trip_start_time: String(schedule?.start_time || '').trim(),
            direction_id: String(direction?.direction_id ?? '').trim()
          }],
          scheduled: true,
          source: 'static'
          });
        }
      }
    }

    return result;
  }

  function normalizeServiceDate(value) {
    return String(value ?? '').trim().replace(/-/g, '');
  }

  function staticArrivalMatchesRealtimeDescriptor(staticArrival, realtimeTrip, now) {
    const realtimeDate = normalizeServiceDate(
      realtimeTrip?.trip_start_date || realtimeTrip?.start_date
    );
    const staticDate = normalizeServiceDate(
      staticArrival?.trip_start_date || staticArrival?.times?.[0]?.trip_start_date
    );
    if (realtimeDate && staticDate && realtimeDate !== staticDate) return false;
    if (!realtimeDate && staticDate !== normalizeServiceDate(getSofiaDateKey(now))) return false;

    const staticRouteId = String(staticArrival?.route_id || '').trim();
    const realtimeRouteId = String(realtimeTrip?.route_id || '').trim();
    if (!staticRouteId || !realtimeRouteId || staticRouteId !== realtimeRouteId) return false;

    const staticTripId = String(staticArrival?.original_trip_id || '').trim();
    const realtimeTripId = String(realtimeTrip?.trip_id || realtimeTrip?.matched_static_trip_id || '').trim();
    const staticStartTime = String(staticArrival?.trip_start_time || '').trim();
    const realtimeStartTime = String(
      realtimeTrip?.trip_start_time || realtimeTrip?.start_time || ''
    ).trim();

    // A supplied Trip ID must identify the same GTFS trip. A different ID is
    // not remapped by comparing timestamps from StopTimeEvents.
    if (realtimeTripId) {
      return realtimeTripId === staticTripId
        && (!realtimeStartTime || !staticStartTime || realtimeStartTime === staticStartTime);
    }

    const realtimeDirectionId = String(realtimeTrip?.direction_id || '').trim();
    if (!realtimeDate || !realtimeStartTime || !realtimeDirectionId
      || (staticStartTime && staticStartTime !== realtimeStartTime)) return false;

    const mapped = findStaticScheduleInfoForRealtime(
      staticRouteId,
      '',
      realtimeStartTime,
      realtimeDirectionId,
      realtimeDate,
      now
    );
    return String(mapped?.schedule?.original_trip_id || '').trim() === staticTripId;
  }

  function staticArrivalIsCovered(staticArrival, realtimeRoutes, realtimeTrips, now, selectedStopId) {
    if (!String(staticArrival?.route_id || '').trim()) return false;

    for (const realtimeTrip of realtimeTrips) {
      if (!staticArrivalMatchesRealtimeDescriptor(staticArrival, realtimeTrip, now)) continue;

      const relationship = getTripRelationship(realtimeTrip);
      if (relationship === 'CANCELED' || relationship === 'DELETED' || relationship === 'REPLACEMENT') {
        return true;
      }
      if (relationship !== 'SCHEDULED' || !isTripUpdateFresh(realtimeTrip, now)) continue;

      const staticInfo = findStaticScheduleInfoForRealtime(
        realtimeTrip?.route_id,
        realtimeTrip?.trip_id,
        realtimeTrip?.trip_start_time || realtimeTrip?.start_time,
        realtimeTrip?.direction_id,
        realtimeTrip?.trip_start_date || realtimeTrip?.start_date,
        now
      );
      if (!staticInfo
        || String(staticInfo.schedule?.original_trip_id || '').trim()
          !== String(staticArrival.original_trip_id || '').trim()) continue;

      const resolution = resolveScheduledTripAtStop(
        realtimeTrip,
        staticInfo,
        selectedStopId,
        now,
        Number.isInteger(staticArrival?.stop_index) ? staticArrival.stop_index : null
      );
      if (resolution.suppressStatic) return true;
    }

    // A stop-specific realtime prediction already contains an arrival for this
    // selected stop. It replaces only the matching static trip, not every trip
    // on the same route or every stop along the trip.
    for (const realtime of realtimeRoutes) {
      if (!isTripUpdateFresh(realtime, now)) continue;
      if (!staticArrivalMatchesRealtimeDescriptor(staticArrival, realtime, now)) continue;

      const staticSequence = optionalFiniteNumber(staticArrival.stop_sequence);
      const realtimeTimes = Array.isArray(realtime.times) ? realtime.times : [];
      const exactOccurrence = realtimeTimes.some(time => {
        const sequence = optionalFiniteNumber(time?.stop_sequence);
        if (sequence !== null) return staticSequence !== null && sequence === staticSequence;
        const pattern = directions?.[staticArrival.route_id]?.[staticArrival.direction_key]?.pattern || [];
        return pattern.filter(id => gtfsIdsEqual(id, selectedStopId)).length === 1;
      });
      if (exactOccurrence) return true;
    }

    return false;
  }

  function mergeRoutes(routes) {
    const grouped = new Map();

    for (const route of routes) {
      const routeId = String(route?.route_id || '').trim();
      const terminalStopId = String(route?.terminal_stop_id || route?.destination_stop_id || '').trim();
      const destinationKey = terminalStopId
        ? `stop:${terminalStopId}`
        : `name:${normalizeDirectionText(route?.destination || route?.headsign || '')}`;
      const key = `${routeId}|${destinationKey}`;
      const times = Array.isArray(route?.times) ? route.times : [];
      if (!grouped.has(key)) {
        grouped.set(key, { ...route, times: [...times] });
        continue;
      }

      const existing = grouped.get(key);
      existing.times.push(...times);
      if ((!existing.route_ref || existing.route_ref === '—') && route?.route_ref && route.route_ref !== '—') {
        existing.route_ref = route.route_ref;
      }
      if (!existing.meta && route?.meta) existing.meta = route.meta;
      if (route?.realtime && !existing.realtime) {
        grouped.set(key, { ...route, route_ref: existing.route_ref || route.route_ref, meta: route.meta || existing.meta, times: existing.times });
      }
    }

    return [...grouped.values()]
      .map(route => {
        const seen = new Set();
        const times = (route.times || [])
          .filter(time => time?.timestamp !== null && time?.timestamp !== undefined && Number.isFinite(Number(time.timestamp)))
          .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
          .filter(time => {
            const timestamp = Number(time.timestamp);
            if (seen.has(timestamp)) return false;
            seen.add(timestamp);
            return true;
          })
          .slice(0, MAX_ARRIVALS_PER_LINE);
        return { ...route, times };
      })
      .filter(route => route.times.length)
      .sort((a, b) => Number(a.times[0].timestamp) - Number(b.times[0].timestamp));
  }

  function buildBoard(realtimeBoard, stopCode, now = new Date()) {
    const rawCode = String(stopCode ?? '').trim();
    const selectedStop = stopById.get(rawCode) || stopByCode.get(rawCode) || getStop(rawCode);
    const selectedStopId = String(selectedStop?.stop_id || rawCode).trim();
    if (!selectedStopId) return { status: 'empty', stop_code: rawCode, generated_at: realtimeBoard?.generated_at || null, routes: [] };

    const isMetro = /^M/i.test(selectedStopId) || /^M/i.test(String(selectedStop?.stop_code || ''));
    const rawRealtimeRoutes = isMetro ? [] : (Array.isArray(realtimeBoard?.routes) ? realtimeBoard.routes : []);
    // Complete TripUpdate descriptors are supplied separately from direct
    // stop arrivals. The resolver decides whether each exact scheduled course
    // has a usable prediction at this stop; otherwise the GTFS arrival remains.
    const realtimeTrips = isMetro
      ? []
      : (Array.isArray(realtimeBoard?.realtime_trips) ? realtimeBoard.realtime_trips : []);
    const realtimeRoutes = [];
    const dayType = getScheduleDayType(now, calendar);

    for (const route of rawRealtimeRoutes) {
      const rawRouteId = String(route?.route_id || '').trim();
      const realtimeTripId = String(route?.trip_id || '').trim();
      if (!Array.isArray(route?.times) || !route.times.length) continue;

      // The API parser emits both a full TripUpdate descriptor and a
      // stop-specific projection for compatibility. When the full descriptor
      // exists, it is authoritative: never let the projection bypass ordered
      // stop validation, NO_DATA propagation or trip-level freshness checks.
      const hasFullDescriptor = realtimeTrips.some(trip => {
        const descriptorTripId = String(trip?.trip_id || '').trim();
        const descriptorDate = String(trip?.trip_start_date || trip?.start_date || '').trim();
        const routeDate = String(route?.trip_start_date || route?.start_date || '').trim();
        const descriptorTime = String(trip?.trip_start_time || trip?.start_time || '').trim();
        const routeTime = String(route?.trip_start_time || route?.start_time || '').trim();
        const descriptorRoute = String(trip?.route_id || '').trim();
        const descriptorDirection = String(trip?.direction_id || '').trim();
        const routeDirection = String(route?.direction_id || route?.directionId || '').trim();

        const sameTripId = !!realtimeTripId && descriptorTripId === realtimeTripId;
        const sameDescriptorTuple = !!descriptorDate && descriptorDate === routeDate
          && !!descriptorTime && descriptorTime === routeTime
          && !!descriptorRoute && descriptorRoute === rawRouteId
          && !!descriptorDirection && descriptorDirection === routeDirection;
        const optionalFieldsAgree = (!descriptorDate || !routeDate || descriptorDate === routeDate)
          && (!descriptorTime || !routeTime || descriptorTime === routeTime)
          && (!descriptorRoute || !rawRouteId || descriptorRoute === rawRouteId)
          && (!descriptorDirection || !routeDirection || descriptorDirection === routeDirection);
        return (sameTripId || sameDescriptorTuple) && optionalFieldsAgree;
      });
      if (hasFullDescriptor) continue;
      if (!isTripUpdateFresh(route, now)) continue;

      const relationshipName = String(route?.schedule_relationship_name || '').trim().toUpperCase();
      const relationship = optionalFiniteNumber(route?.schedule_relationship);
      const relationshipByNumber = ({
        0: 'SCHEDULED',
        1: 'ADDED',
        2: 'UNSCHEDULED',
        3: 'CANCELED',
        5: 'REPLACEMENT',
        6: 'DUPLICATED',
        7: 'DELETED',
        8: 'NEW'
      })[relationship];
      if (relationshipName && relationshipByNumber && relationshipName !== relationshipByNumber) continue;
      const tripRelationship = relationshipName || relationshipByNumber || (relationship === null ? 'SCHEDULED' : 'UNKNOWN');
      // CANCELED/DELETED descriptors suppress their static trip through the
      // complete TripUpdate path. DUPLICATED needs TripProperties plus a
      // shifted schedule; do not render it under the original trip identity.
      if (['CANCELED', 'DELETED', 'DUPLICATED', 'INVALID_RELATIONSHIP', 'UNKNOWN'].includes(tripRelationship)) continue;
      const isScheduled = tripRelationship === 'SCHEDULED';
      const staticInfo = isScheduled
        ? findStaticScheduleInfoForRealtime(
          rawRouteId,
          realtimeTripId,
          route?.trip_start_time,
          route?.direction_id,
          route?.trip_start_date || route?.start_date,
          now
        )
        : null;
      if (isScheduled && !staticInfo) continue;
      const routeId = rawRouteId || String(staticInfo?.routeId || '').trim();
      if (!routeId) continue;
      const canonicalTripId = String(staticInfo?.schedule?.original_trip_id || realtimeTripId).trim();
      const producerTripId = realtimeTripId && realtimeTripId !== canonicalTripId
        ? realtimeTripId
        : '';

      const direction = staticInfo?.direction || findDirection(
        routeId,
        selectedStopId,
        route?.destination || '',
        route?.direction_id || route?.directionId || ''
      );
      const scheduledTerminalStopId = isScheduled
        ? (staticInfo?.terminalStopId
          || String(direction?.pattern?.[direction.pattern.length - 1] || '').trim())
        : '';

      // For scheduled trips, use the trip's own GTFS terminal. In particular,
      // do not mistake the last StopTimeUpdate received so far for a terminal:
      // realtime feeds may omit updates for later stops. Static trip lookup
      // also identifies short-turn courses by their last populated stop time.
      if (scheduledTerminalStopId && gtfsIdsEqual(scheduledTerminalStopId, selectedStopId)) {
        continue;
      }

      const terminalStopId = (isScheduled && staticInfo?.terminalStopId)
        ? staticInfo.terminalStopId
        : (String(route?.destination_stop_id || '').trim()
          || staticInfo?.terminalStopId
          || String(direction?.pattern?.[direction.pattern.length - 1] || '').trim());
      const meta = createRouteMetadata(routeById.get(routeId)) || {
        id: routeId,
        number: String(route?.route_ref || '—'),
        type: 'bus',
        subtype: '',
        icon: '',
        color: '#BE1E2D',
        textColor: '#FFFFFF'
      };
      const destination = getDestinationName(
        terminalStopId,
        direction,
        route?.destination || direction?.destination || direction?.headsign || ''
      );

      const times = route.times.map(time => {
        let timestamp = optionalFiniteNumber(time?.timestamp);
        const delay = optionalFiniteNumber(time?.delay);
        const eventType = String(time?.event_type || 'departure').toLowerCase() === 'arrival'
          ? 'arrival'
          : 'departure';
        let stopIndex = -1;
        if (staticInfo) {
          const sequence = optionalFiniteNumber(time?.stop_sequence);
          const eventStopId = String(time?.stop_id || '').trim();
          if (sequence !== null) {
            stopIndex = staticInfo.schedule.stop_sequences.findIndex(value => Number(value) === sequence);
            if (stopIndex >= 0 && eventStopId
              && String(staticInfo.direction.pattern[stopIndex]).trim() !== eventStopId) {
              stopIndex = -1;
            }
          } else if (eventStopId) {
            const matchingIndexes = staticInfo.direction.pattern
              .map((id, index) => String(id).trim() === eventStopId ? index : -1)
              .filter(index => index >= 0);
            if (matchingIndexes.length === 1) stopIndex = matchingIndexes[0];
          } else {
            const matchingIndexes = staticInfo.direction.pattern
              .map((id, index) => gtfsIdsEqual(id, selectedStopId) ? index : -1)
              .filter(index => index >= 0);
            if (matchingIndexes.length === 1) stopIndex = matchingIndexes[0];
          }
          if (stopIndex >= 0 && !gtfsIdsEqual(staticInfo.direction.pattern[stopIndex], selectedStopId)) {
            stopIndex = -1;
          }
        }
        if (staticInfo && stopIndex < 0) return null;
        const scheduledStopSeconds = staticInfo && stopIndex >= 0
          ? getScheduledSecondsForEvent(staticInfo.schedule, stopIndex, eventType)
          : null;
        const explicitScheduledTime = isScheduled
          ? null
          : optionalFiniteNumber(time?.scheduled_time);
        const gtfsScheduledTime = scheduledStopSeconds !== null
          ? gtfsSecondsToServiceTimestamp(scheduledStopSeconds, staticInfo.serviceDate || now)
          : null;
        const scheduledTime = explicitScheduledTime ?? gtfsScheduledTime;

        // If the producer gives delay but no absolute time, derive the
        // prediction from this exact course's scheduled time at this stop.
        if (timestamp === null && delay !== null && gtfsScheduledTime !== null) {
          timestamp = gtfsScheduledTime + delay;
        }
        // StopTimeEvent.scheduled_time is descriptive schedule metadata for
        // NEW/REPLACEMENT/DUPLICATED trips, never a prediction by itself.
        if (timestamp === null) return null;

        if (timestamp < now.getTime() / 1000 - REALTIME_PAST_GRACE_SECONDS) return null;
        if (timestamp > now.getTime() / 1000 + MAX_REALTIME_LOOKAHEAD_SECONDS) return null;

        const effectiveDelay = timestamp !== null && gtfsScheduledTime !== null
          ? timestamp - gtfsScheduledTime
          : delay;

        return {
          timestamp,
          delay: effectiveDelay,
          scheduled: false,
          source: 'realtime',
          scheduled_time: scheduledTime,
          route_id: routeId,
          trip_id: canonicalTripId,
          realtime_trip_id: producerTripId,
          trip_start_date: normalizeServiceDate(
            route?.trip_start_date || route?.start_date || getSofiaDateKey(now)
          ),
          trip_start_time: String(staticInfo?.schedule?.start_time || route?.trip_start_time || '').trim(),
          direction_id: String(staticInfo?.direction?.direction_id ?? route?.direction_id ?? '').trim(),
          uncertainty: optionalFiniteNumber(time?.uncertainty),
          event_type: eventType,
          stop_schedule_relationship: optionalFiniteNumber(time?.stop_schedule_relationship),
          stop_schedule_relationship_name: String(time?.stop_schedule_relationship_name || 'SCHEDULED')
        };
      }).filter(Boolean);

      if (!times.length) continue;

      realtimeRoutes.push({
        ...route,
        route_id: routeId,
        trip_id: canonicalTripId,
        realtime_trip_id: producerTripId,
        matched_static_trip_id: staticInfo ? canonicalTripId : '',
        route_ref: meta.number,
        meta,
        direction_key: staticInfo?.directionKey || direction?.key || '',
        direction_id: String(staticInfo?.direction?.direction_id ?? route?.direction_id ?? '').trim(),
        trip_start_time: String(staticInfo?.schedule?.start_time || route?.trip_start_time || '').trim(),
        terminal_stop_id: terminalStopId,
        destination_stop_id: terminalStopId,
        destination,
        realtime: true,
        scheduled: false,
        source: 'realtime',
        times
      });
    }

    // A TripUpdate can contain only a trip-level delay or StopTimeUpdates
    // for earlier stops. Per GTFS-Realtime semantics, that delay propagates to
    // subsequent stops until a later update changes it or NO_DATA clears it.
    // Build a stop-specific prediction from that information when the feed has
    // not supplied a direct prediction for the selected stop.
    for (const realtimeTrip of realtimeTrips) {
      const tripId = String(realtimeTrip?.trip_id || '').trim();
      const tripRouteId = String(realtimeTrip?.route_id || '').trim();
      const tripStartTime = String(realtimeTrip?.trip_start_time || realtimeTrip?.start_time || '').trim();
      const mappedStaticInfo = findStaticScheduleInfoForRealtime(
        tripRouteId,
        tripId,
        tripStartTime,
        realtimeTrip?.direction_id,
        realtimeTrip?.trip_start_date || realtimeTrip?.start_date,
        now
      );
      const canonicalTripId = String(mappedStaticInfo?.schedule?.original_trip_id || tripId).trim();
      const alreadyHasStopPrediction = realtimeRoutes.some(route => {
        const routeTripId = String(route?.trip_id || route?.matched_static_trip_id || '').trim();
        const producerTripId = String(route?.realtime_trip_id || '').trim();
        const routeStartTime = String(route?.trip_start_time || '').trim();
        const sameTrip = (canonicalTripId && routeTripId && canonicalTripId === routeTripId)
          || (tripId && producerTripId && tripId === producerTripId);
        const sameRoute = !tripRouteId || !route?.route_id || tripRouteId === String(route.route_id).trim();
        return sameTrip && sameRoute && (!tripStartTime || !routeStartTime || tripStartTime === routeStartTime);
      });
      if (alreadyHasStopPrediction) continue;

      const inferredRoute = buildRealtimeRouteFromTripUpdate(realtimeTrip, selectedStopId, now);
      if (inferredRoute) realtimeRoutes.push(inferredRoute);
    }

    const allStaticArrivals = getStaticArrivals(
      selectedStopId,
      isMetro,
      realtimeBoard?.skipped_trips || [],
      now
    );
    const staticArrivals = allStaticArrivals.filter(
      route => !staticArrivalIsCovered(route, realtimeRoutes, realtimeTrips, now, selectedStopId)
    );

    const routes = mergeRoutes([...realtimeRoutes, ...staticArrivals]);
    return {
      status: routes.length ? 'ok' : 'empty',
      stop_code: rawCode,
      generated_at: realtimeBoard?.generated_at || Math.floor(now.getTime() / 1000),
      routes
    };
  }

  return { buildBoard };
}

const defaultService = createDataContext();

function buildVirtualBoard(realtimeBoard, stopCode, now = new Date()) {
  return defaultService.buildBoard(realtimeBoard, stopCode, now);
}

module.exports = {
  buildVirtualBoard,
  createDataContext
};
