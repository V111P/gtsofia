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

function gtfsSecondsToTodayTimestamp(seconds, date) {
  const { year, month, day } = getSofiaDateParts(date);
  const baseUtc = Date.UTC(year, month - 1, day);
  return (baseUtc + Number(seconds) * 1000 - getSofiaOffsetMs(new Date(baseUtc))) / 1000;
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
  // of rescanning every route, direction and pattern on every 15s refresh.
  const directionsByStop = new Map();
  for (const route of routes) {
    const routeId = String(route?.route_id || '').trim();
    if (!routeId) continue;

    const routeDirections = directions?.[routeId] || {};
    for (const [directionKey, direction] of Object.entries(routeDirections)) {
      const pattern = Array.isArray(direction?.pattern) ? direction.pattern.map(String) : [];
      if (!pattern.length) continue;

      const indexedStopKeys = new Set();
      for (let stopIndex = 0; stopIndex < pattern.length; stopIndex++) {
        const stopKey = normalizeStopKey(pattern[stopIndex]);
        if (!stopKey || indexedStopKeys.has(stopKey)) continue;
        indexedStopKeys.add(stopKey);

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
      ? directionStops.find(item => stopIdsMatch(item?.stop_id, stopId))
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
        && direction.pattern.some(id => stopIdsMatch(id, stopId)))
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

  function findStaticScheduleInfo(routeId, originalTripId, dayType) {
    const wantedTripId = String(originalTripId ?? '').trim();
    if (!wantedTripId) return null;

    const routeIds = routeId ? [String(routeId)] : Object.keys(schedules || {});
    const dayOrder = [dayType, dayType === 'weekday' ? 'weekend' : 'weekday'];

    for (const currentDayType of dayOrder) {
      for (const currentRouteId of routeIds) {
        const routeSchedules = schedules?.[currentRouteId] || {};
        for (const [directionKey, daySchedules] of Object.entries(routeSchedules)) {
          const rows = Array.isArray(daySchedules?.[currentDayType]) ? daySchedules[currentDayType] : [];
          const schedule = rows.find(row => String(row?.original_trip_id ?? '').trim() === wantedTripId);
          if (!schedule) continue;

          const info = makeStaticScheduleInfo(currentRouteId, directionKey, schedule);
          if (info) return info;
        }
      }
    }

    return null;
  }

  function findStaticScheduleInfoByStartTime(routeId, startTime, directionId, dayType) {
    const wantedRouteId = String(routeId ?? '').trim();
    const wantedStartTime = String(startTime ?? '').trim();
    const wantedDirectionId = String(directionId ?? '').trim();
    if (!wantedRouteId || !wantedStartTime) return null;

    const routeSchedules = schedules?.[wantedRouteId] || {};
    const dayOrder = [dayType, dayType === 'weekday' ? 'weekend' : 'weekday'];

    for (const currentDayType of dayOrder) {
      const matches = [];
      for (const [directionKey, daySchedules] of Object.entries(routeSchedules)) {
        const direction = directions?.[wantedRouteId]?.[directionKey];
        if (!direction) continue;
        const actualDirectionId = String(direction.direction_id ?? '').trim();
        if (wantedDirectionId && actualDirectionId && actualDirectionId !== wantedDirectionId) continue;

        const rows = Array.isArray(daySchedules?.[currentDayType]) ? daySchedules[currentDayType] : [];
        for (const schedule of rows) {
          if (String(schedule?.start_time ?? '').trim() !== wantedStartTime) continue;
          const info = makeStaticScheduleInfo(wantedRouteId, directionKey, schedule);
          if (info) matches.push(info);
        }
      }

      const uniqueTripIds = new Set(
        matches.map(item => String(item.schedule?.original_trip_id ?? '').trim()).filter(Boolean)
      );
      if (uniqueTripIds.size === 1 && matches.length) return matches[0];
      if (matches.length > 1) return null;
      if (matches.length === 1) return matches[0];
    }

    return null;
  }

  function getRealtimeUpdateStopIndex(update, staticInfo) {
    const pattern = Array.isArray(staticInfo?.direction?.pattern)
      ? staticInfo.direction.pattern.map(String)
      : [];
    const sequences = Array.isArray(staticInfo?.schedule?.stop_sequences)
      ? staticInfo.schedule.stop_sequences
      : [];

    const sequence = optionalFiniteNumber(update?.stop_sequence);
    if (sequence !== null) {
      const sequenceIndex = sequences.findIndex(value => Number(value) === sequence);
      if (sequenceIndex >= 0 && sequenceIndex < pattern.length) return sequenceIndex;
    }

    const stopId = String(update?.stop_id || '').trim();
    if (!stopId) return -1;
    const matches = [];
    for (let index = 0; index < pattern.length; index++) {
      if (stopIdsMatch(pattern[index], stopId)) matches.push(index);
    }
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

  function getRealtimeEventDelay(event, stopIndex, schedule, now) {
    const explicitDelay = optionalFiniteNumber(event?.delay);
    if (explicitDelay !== null) return explicitDelay;

    const timestamp = optionalFiniteNumber(event?.timestamp);
    if (timestamp === null) return null;

    const explicitScheduled = optionalFiniteNumber(event?.scheduled_time);
    if (explicitScheduled !== null) return timestamp - explicitScheduled;

    const scheduledSeconds = parseGtfsTime(schedule?.times?.[stopIndex]);
    if (scheduledSeconds === null) return null;
    const scheduledTimestamp = gtfsSecondsToTodayTimestamp(scheduledSeconds, now);
    return timestamp - scheduledTimestamp;
  }

  function buildRealtimeRouteFromTripUpdate(realtimeTrip, selectedStopId, now) {
    const relationshipName = String(realtimeTrip?.schedule_relationship_name || '').trim().toUpperCase();
    const relationship = optionalFiniteNumber(realtimeTrip?.schedule_relationship);
    const isScheduled = relationshipName
      ? relationshipName === 'SCHEDULED'
      : (relationship === null || relationship === 0);
    if (!isScheduled) return null;

    const realtimeDate = normalizeServiceDate(
      realtimeTrip?.trip_start_date || realtimeTrip?.start_date
    );
    if (realtimeDate && realtimeDate !== normalizeServiceDate(getSofiaDateKey(now))) return null;

    const dayType = getScheduleDayType(now, calendar);
    const originalTripId = String(realtimeTrip?.trip_id || '').trim();
    const routeIdHint = String(realtimeTrip?.route_id || '').trim();
    const realtimeStartTime = String(realtimeTrip?.trip_start_time || realtimeTrip?.start_time || '').trim();
    const directionId = String(realtimeTrip?.direction_id || '').trim();

    let staticInfo = originalTripId
      ? findStaticScheduleInfo(routeIdHint, originalTripId, dayType)
      : null;
    if (!staticInfo && routeIdHint && realtimeStartTime) {
      staticInfo = findStaticScheduleInfoByStartTime(routeIdHint, realtimeStartTime, directionId, dayType);
    }
    if (!staticInfo) return null;

    const staticStartTime = String(staticInfo.schedule?.start_time || '').trim();
    if (realtimeStartTime && staticStartTime && realtimeStartTime !== staticStartTime) return null;

    const staticDirectionId = String(staticInfo.direction?.direction_id ?? '').trim();
    if (directionId && staticDirectionId && directionId !== staticDirectionId) return null;

    const pattern = Array.isArray(staticInfo.direction?.pattern)
      ? staticInfo.direction.pattern.map(String)
      : [];
    const targetIndex = pattern.findIndex(id => stopIdsMatch(id, selectedStopId));
    if (targetIndex < 0 || targetIndex > staticInfo.terminalIndex) return null;
    if (stopIdsMatch(staticInfo.terminalStopId, selectedStopId)) return null;

    const targetScheduledSeconds = parseGtfsTime(staticInfo.schedule?.times?.[targetIndex]);
    if (targetScheduledSeconds === null) return null;
    const targetScheduledTimestamp = gtfsSecondsToTodayTimestamp(targetScheduledSeconds, now);

    // GTFS-Realtime delay propagation: TripUpdate.delay applies from the start
    // of the trip until a StopTimeUpdate supplies a new delay. A StopTimeUpdate
    // with NO_DATA clears the known delay for all following stops; SKIPPED does
    // not clear it. StopTimeUpdates can identify a stop by stop_sequence alone.
    let propagatedDelay = optionalFiniteNumber(realtimeTrip?.trip_delay);
    let propagatedUncertainty = null;
    let targetEvent = null;
    let targetRelationship = 0;
    let targetSkipped = false;
    let targetNoData = false;

    const updates = (Array.isArray(realtimeTrip?.stop_time_updates) ? realtimeTrip.stop_time_updates : [])
      .map((update, sourceIndex) => ({
        update,
        sourceIndex,
        stopIndex: getRealtimeUpdateStopIndex(update, staticInfo)
      }))
      .filter(item => item.stopIndex >= 0 && item.stopIndex <= targetIndex)
      .sort((left, right) => left.stopIndex - right.stopIndex || left.sourceIndex - right.sourceIndex);

    for (const item of updates) {
      const update = item.update;
      const stopRelationship = optionalFiniteNumber(update?.schedule_relationship) ?? 0;
      const isTargetStop = item.stopIndex === targetIndex;

      if (stopRelationship === 2) { // NO_DATA
        propagatedDelay = null;
        propagatedUncertainty = null;
        if (isTargetStop) {
          targetNoData = true;
          targetRelationship = stopRelationship;
        }
        continue;
      }

      if (stopRelationship === 1) { // SKIPPED: keep the previous delay for later stops.
        if (isTargetStop) {
          targetSkipped = true;
          targetRelationship = stopRelationship;
        }
        continue;
      }

      const event = getRealtimeEvent(update, !isTargetStop);
      if (event) {
        const eventDelay = getRealtimeEventDelay(event, item.stopIndex, staticInfo.schedule, now);
        if (eventDelay !== null) propagatedDelay = eventDelay;
        const uncertainty = optionalFiniteNumber(event.uncertainty);
        if (uncertainty !== null) propagatedUncertainty = uncertainty;
        if (isTargetStop) {
          targetEvent = event;
          targetRelationship = stopRelationship;
        }
      } else if (isTargetStop) {
        targetRelationship = stopRelationship;
      }
    }

    if (targetSkipped || targetNoData) return null;

    let timestamp = optionalFiniteNumber(targetEvent?.timestamp);
    const directDelay = getRealtimeEventDelay(targetEvent, targetIndex, staticInfo.schedule, now);
    const delay = directDelay !== null ? directDelay : propagatedDelay;
    if (timestamp === null && delay !== null) {
      timestamp = targetScheduledTimestamp + delay;
    }
    if (timestamp === null) return null;

    const nowTimestamp = now.getTime() / 1000;
    if (timestamp < nowTimestamp - REALTIME_PAST_GRACE_SECONDS) return null;
    if (timestamp > nowTimestamp + MAX_REALTIME_LOOKAHEAD_SECONDS) return null;

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
      trip_id: originalTripId,
      trip_start_date: realtimeDate,
      trip_start_time: staticStartTime || realtimeStartTime,
      route_ref: meta.number,
      meta,
      direction_key: staticInfo.directionKey,
      direction_id: String(staticInfo.direction?.direction_id ?? directionId).trim(),
      terminal_stop_id: staticInfo.terminalStopId,
      destination_stop_id: staticInfo.terminalStopId,
      destination,
      realtime: true,
      scheduled: false,
      source: 'realtime',
      times: [{
        timestamp,
        delay,
        scheduled: false,
        source: 'realtime',
        scheduled_time: targetScheduledTimestamp,
        uncertainty: optionalFiniteNumber(targetEvent?.uncertainty) ?? propagatedUncertainty,
        stop_schedule_relationship: targetRelationship,
        stop_schedule_relationship_name: targetRelationship === 1 ? 'SKIPPED' : (targetRelationship === 2 ? 'NO_DATA' : 'SCHEDULED')
      }]
    };
  }

  function isSkipped(schedule, routeId, stopId, stopIndex, skippedTrips) {
    const originalTripId = String(schedule?.original_trip_id || '').trim();
    const stopSequence = Number(schedule?.stop_sequences?.[stopIndex]);

    return skippedTrips.some(skipped => {
      if (!skipped) return false;
      if (String(skipped.route_id || '').trim() !== String(routeId).trim()) return false;

      const skippedStopId = String(skipped.stop_id || '').trim();
      if (skippedStopId) {
        if (!stopIdsMatch(skippedStopId, stopId)) return false;
      } else {
        const skippedSequence = Number(skipped.stop_sequence);
        if (!Number.isFinite(skippedSequence) || !Number.isFinite(stopSequence) || skippedSequence !== stopSequence) return false;
      }

      return !!originalTripId && String(skipped.trip_id || '').trim() === originalTripId;
    });
  }

  function getStaticArrivals(stopId, isMetro, skippedTrips, now) {
    const dayType = getScheduleDayType(now, calendar);
    const nowTimestamp = now.getTime() / 1000;
    const result = [];
    const serviceStatus = new Map();
    const candidates = directionsByStop.get(normalizeStopKey(stopId)) || [];

    function serviceIsActive(serviceId) {
      const id = String(serviceId || '').trim();
      if (!id) return true;
      if (!serviceStatus.has(id)) {
        serviceStatus.set(id, isServiceActive(id, now, calendar));
      }
      return serviceStatus.get(id);
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
      const dayRows = daySchedules?.[dayType];
      if (!Array.isArray(dayRows)) continue;

      for (const schedule of dayRows) {
        const serviceId = String(schedule?.service_id || direction?.service_id || '').trim();
        if (!serviceIsActive(serviceId)) continue;

        const seconds = parseGtfsTime(schedule?.times?.[stopIndex]);
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
        if (!terminalStopId || isSkipped(schedule, routeId, stopId, stopIndex, skippedTrips)) continue;

        // A timetable trip must not be shown at the stop where that exact
        // trip ends. The last populated time identifies the terminal for
        // both full-length and partial (short-turn) trips.
        if (stopIdsMatch(terminalStopId, stopId)) continue;

        const timestamp = gtfsSecondsToTodayTimestamp(seconds, now);
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
          static_trip_id: String(schedule?.trip_id ?? '').trim(),
          trip_start_time: String(schedule?.start_time || '').trim(),
          times: [{ timestamp, delay: null, scheduled: true, source: 'static' }],
          scheduled: true,
          source: 'static'
        });
      }
    }

    return result;
  }

  function normalizeServiceDate(value) {
    return String(value ?? '').trim().replace(/-/g, '');
  }

  function staticArrivalMatchesRealtimeDescriptor(staticArrival, realtimeTrip, now, allStaticArrivals = []) {
    const realtimeDate = normalizeServiceDate(
      realtimeTrip?.trip_start_date || realtimeTrip?.start_date
    );
    if (realtimeDate && realtimeDate !== normalizeServiceDate(getSofiaDateKey(now))) {
      return false;
    }

    // Only original_trip_id is the GTFS identifier shared with GTFS-Realtime.
    // static_trip_id / trip_id in our aggregated schedule are internal numeric
    // grouping keys and must never be used to suppress a fallback course.
    const staticOriginalTripIdExact = String(staticArrival?.original_trip_id ?? '').trim();
    const realtimeTripId = String(
      realtimeTrip?.trip_id || realtimeTrip?.matched_static_trip_id || ''
    ).trim();

    // A real Trip ID is the strongest course identity. It suppresses the
    // static fallback even when this TripUpdate has no usable prediction at
    // the selected stop. When GTFS-RT supplies start_time as well (notably for
    // duplicated trip instances), it is part of the identity too: a second
    // instance of the same template must not hide the original scheduled run.
    if (realtimeTripId) {
      if (!staticOriginalTripIdExact || staticOriginalTripIdExact !== realtimeTripId) return false;

      const staticRouteId = String(staticArrival?.route_id || '').trim();
      const realtimeRouteId = String(realtimeTrip?.route_id || '').trim();
      if (staticRouteId && realtimeRouteId && staticRouteId !== realtimeRouteId) return false;

      const staticStartTime = String(staticArrival?.trip_start_time || '').trim();
      const realtimeStartTime = String(
        realtimeTrip?.trip_start_time || realtimeTrip?.start_time || ''
      ).trim();
      if (staticStartTime && realtimeStartTime && staticStartTime !== realtimeStartTime) return false;

      return true;
    }

    const staticRouteId = String(staticArrival?.route_id || '').trim();
    const realtimeRouteId = String(realtimeTrip?.route_id || '').trim();
    const staticStartTime = String(staticArrival?.trip_start_time || '').trim();
    const realtimeStartTime = String(
      realtimeTrip?.trip_start_time || realtimeTrip?.start_time || ''
    ).trim();
    if (!staticRouteId || staticRouteId !== realtimeRouteId) return false;

    const staticDirectionId = String(staticArrival?.direction_id || '').trim();
    const realtimeDirectionId = String(realtimeTrip?.direction_id || '').trim();
    if (staticDirectionId && realtimeDirectionId && staticDirectionId !== realtimeDirectionId) {
      return false;
    }

    // If the producer omits both Trip ID and trip start time, the scheduled
    // event time at this exact stop can still identify the same course. This
    // is deliberately exact (not the former +/-120s guess), and it is used
    // only when that route/time identifies one static course unambiguously.
    const eventMatchStaticTripId = String(staticArrival?.original_trip_id || '').trim();
    const realtimeTimes = Array.isArray(realtimeTrip?.times) ? realtimeTrip.times : [];
    for (const time of realtimeTimes) {
      const explicitScheduled = optionalFiniteNumber(time?.scheduled_time);
      const realtimeTimestamp = optionalFiniteNumber(time?.timestamp);
      const delay = optionalFiniteNumber(time?.delay);
      const inferredScheduled = explicitScheduled !== null
        ? explicitScheduled
        : (realtimeTimestamp !== null && delay !== null ? realtimeTimestamp - delay : null);
      if (inferredScheduled === null) continue;

      const matchingStaticCourses = allStaticArrivals.filter(candidate => {
        if (String(candidate?.route_id || '').trim() !== staticRouteId) return false;
        const candidateDirectionId = String(candidate?.direction_id || '').trim();
        if (realtimeDirectionId && candidateDirectionId && candidateDirectionId !== realtimeDirectionId) return false;
        return (Array.isArray(candidate?.times) ? candidate.times : []).some(
          candidateTime => optionalFiniteNumber(candidateTime?.timestamp) === inferredScheduled
        );
      });

      if (matchingStaticCourses.length === 1
        && String(matchingStaticCourses[0]?.original_trip_id || '').trim() === eventMatchStaticTripId) {
        return true;
      }
    }

    if (!staticStartTime || !realtimeStartTime || staticStartTime !== realtimeStartTime) return false;

    // Feeds that omit Trip ID can still be matched safely by route + exact
    // start time, but only if those fields identify one static trip uniquely.
    const dayType = getScheduleDayType(now, calendar);
    const routeSchedules = schedules?.[staticRouteId] || {};
    const candidateTripIds = new Set();

    for (const [directionKey, daySchedules] of Object.entries(routeSchedules)) {
      const direction = directions?.[staticRouteId]?.[directionKey];
      const candidateDirectionId = String(direction?.direction_id || '').trim();
      if (staticDirectionId && candidateDirectionId && staticDirectionId !== candidateDirectionId) continue;
      if (realtimeDirectionId && candidateDirectionId && realtimeDirectionId !== candidateDirectionId) continue;

      const rows = Array.isArray(daySchedules?.[dayType]) ? daySchedules[dayType] : [];
      for (const row of rows) {
        if (String(row?.start_time || '').trim() !== realtimeStartTime) continue;
        const serviceId = String(row?.service_id || direction?.service_id || '').trim();
        if (serviceId && !isServiceActive(serviceId, now, calendar)) continue;
        const tripId = String(row?.original_trip_id || '').trim();
        if (tripId) candidateTripIds.add(tripId);
      }
    }

    const staticOriginalTripId = String(staticArrival?.original_trip_id || '').trim();
    return candidateTripIds.size === 1 && candidateTripIds.has(staticOriginalTripId);
  }

  function staticArrivalIsCovered(staticArrival, realtimeRoutes, realtimeTrips, now, allStaticArrivals) {
    if (!String(staticArrival?.route_id || '').trim()) return false;

    // A matching TripUpdate owns this exact scheduled course. Never let its
    // static time reappear later, even when the realtime prediction for this
    // stop is absent, has already passed, or is marked NO_DATA. Otherwise a
    // stale timetable time can remain on the board until its scheduled time
    // and temporarily hide the next actual departure. Other courses remain
    // eligible for the normal static fallback.
    for (const realtimeTrip of realtimeTrips) {
      if (staticArrivalMatchesRealtimeDescriptor(staticArrival, realtimeTrip, now, allStaticArrivals)) {
        return true;
      }
    }

    // Be defensive for callers that pass only stop-specific realtime routes
    // rather than the complete descriptor list produced by the API parser.
    for (const realtime of realtimeRoutes) {
      if (staticArrivalMatchesRealtimeDescriptor(staticArrival, realtime, now, allStaticArrivals)) return true;
    }

    return false;
  }

  function mergeRoutes(routes) {
    const grouped = new Map();

    for (const route of routes) {
      const routeId = String(route?.route_id || '').trim();
      const terminalStopId = String(route?.terminal_stop_id || route?.destination_stop_id || '').trim();
      const destinationKey = terminalStopId
        ? `stop:${normalizeStopKey(terminalStopId)}`
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
    // Complete TripUpdate descriptors are supplied separately from arrivals
    // at this stop. This lets us suppress only the matching static course when
    // that course exists in realtime but has no prediction for this stop.
    const realtimeTrips = isMetro ? [] : [
      ...(Array.isArray(realtimeBoard?.realtime_trips) ? realtimeBoard.realtime_trips : []),
      ...rawRealtimeRoutes
    ];
    const realtimeRoutes = [];
    const dayType = getScheduleDayType(now, calendar);

    for (const route of rawRealtimeRoutes) {
      const rawRouteId = String(route?.route_id || '').trim();
      const realtimeTripId = String(route?.trip_id || '').trim();
      if (!Array.isArray(route?.times) || !route.times.length) continue;

      const staticInfo = findStaticScheduleInfo(rawRouteId, realtimeTripId, dayType)
        || (!realtimeTripId
          ? findStaticScheduleInfoByStartTime(rawRouteId, route?.trip_start_time, route?.direction_id, dayType)
          : null);
      const routeId = rawRouteId || String(staticInfo?.routeId || '').trim();
      if (!routeId) continue;

      const direction = staticInfo?.direction || findDirection(
        routeId,
        selectedStopId,
        route?.destination || '',
        route?.direction_id || route?.directionId || ''
      );
      const relationshipName = String(route?.schedule_relationship_name || '').trim().toUpperCase();
      const relationship = Number(route?.schedule_relationship);
      const isScheduled = relationshipName
        ? relationshipName === 'SCHEDULED'
        : (!Number.isFinite(relationship) || relationship === 0);
      const scheduledTerminalStopId = isScheduled
        ? (staticInfo?.terminalStopId
          || String(direction?.pattern?.[direction.pattern.length - 1] || '').trim())
        : '';

      // For scheduled trips, use the trip's own GTFS terminal. In particular,
      // do not mistake the last StopTimeUpdate received so far for a terminal:
      // realtime feeds may omit updates for later stops. Static trip lookup
      // also identifies short-turn courses by their last populated stop time.
      if (scheduledTerminalStopId && stopIdsMatch(scheduledTerminalStopId, selectedStopId)) {
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

      const stopIndex = Array.isArray(direction?.pattern)
        ? direction.pattern.findIndex(id => stopIdsMatch(id, selectedStopId))
        : -1;
      const scheduledStopSeconds = staticInfo && stopIndex >= 0
        ? parseGtfsTime(staticInfo.schedule?.times?.[stopIndex])
        : null;
      const times = route.times.map(time => {
        let timestamp = optionalFiniteNumber(time?.timestamp);
        const delay = optionalFiniteNumber(time?.delay);
        const scheduledTime = optionalFiniteNumber(time?.scheduled_time);

        // If the producer gives delay but no absolute time, derive the
        // prediction from this exact course's scheduled time at this stop.
        if (timestamp === null && delay !== null && scheduledStopSeconds !== null) {
          timestamp = gtfsSecondsToTodayTimestamp(scheduledStopSeconds, now) + delay;
        }
        if (timestamp === null && scheduledTime !== null) timestamp = scheduledTime;
        if (timestamp === null) return null;

        if (timestamp < now.getTime() / 1000 - REALTIME_PAST_GRACE_SECONDS) return null;
        if (timestamp > now.getTime() / 1000 + MAX_REALTIME_LOOKAHEAD_SECONDS) return null;

        return {
          timestamp,
          delay,
          scheduled: false,
          source: 'realtime',
          scheduled_time: scheduledTime,
          uncertainty: optionalFiniteNumber(time?.uncertainty),
          stop_schedule_relationship: optionalFiniteNumber(time?.stop_schedule_relationship),
          stop_schedule_relationship_name: String(time?.stop_schedule_relationship_name || 'SCHEDULED')
        };
      }).filter(Boolean);

      if (!times.length) continue;

      realtimeRoutes.push({
        ...route,
        route_id: routeId,
        matched_static_trip_id: !realtimeTripId
          ? String(staticInfo?.schedule?.original_trip_id || '').trim()
          : '',
        route_ref: meta.number,
        meta,
        direction_key: staticInfo?.directionKey || direction?.key || '',
        direction_id: String(route?.direction_id ?? staticInfo?.direction?.direction_id ?? '').trim(),
        trip_start_time: String(route?.trip_start_time || staticInfo?.schedule?.start_time || '').trim(),
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
      const alreadyHasStopPrediction = realtimeRoutes.some(route => {
        const routeTripId = String(route?.trip_id || '').trim();
        const routeStartTime = String(route?.trip_start_time || '').trim();
        const sameTrip = tripId && routeTripId
          ? tripId === routeTripId
          : (!!tripStartTime && !!routeStartTime && tripStartTime === routeStartTime);
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
      route => !staticArrivalIsCovered(route, realtimeRoutes, realtimeTrips, now, allStaticArrivals)
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
