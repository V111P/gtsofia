'use strict';

const routesData = require('../data/routes.json');
const directionsData = require('../data/directions.json');
const schedulesData = require('../data/schedules.json');
const stopsData = require('../data/stops.json');
const { getRouteMetadata } = require('../route-metadata');
const { buildStopIndexes } = require('../stop-utils');

const TRANSITLAND_BASE_URL = 'https://transit.land/api/v2/rest';
const SOFIA_TIME_ZONE = 'Europe/Sofia';
const FEED_ONESTOP_ID = 'f-sofiatraffic~bg';
const DEFAULT_LOOKAHEAD_SECONDS = 2 * 60 * 60;
const METRO_REQUEST_LOOKAHEAD_SECONDS = 4 * 60 * 60;
const DEFAULT_CACHE_TTL_MS = 60 * 1000;
const METRO_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_STALE_TTL_MS = 3 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 12 * 1000;
const MAX_ARRIVALS_PER_ROUTE = 3;

const routeById = new Map(routesData.map(route => [String(route.route_id), route]));
const stopIndexes = buildStopIndexes(stopsData);
const stopById = stopIndexes.byId;
const tripScheduleLookup = buildTripScheduleLookup();

function buildTripScheduleLookup() {
  const lookup = new Map();
  for (const [routeId, routeDirections] of Object.entries(schedulesData || {})) {
    for (const [directionKey, daySchedules] of Object.entries(routeDirections || {})) {
      for (const dayType of ['weekday', 'weekend']) {
        const rows = Array.isArray(daySchedules?.[dayType]) ? daySchedules[dayType] : [];
        for (const schedule of rows) {
          const tripId = String(schedule?.original_trip_id || '').trim();
          if (!tripId) continue;
          const key = `${routeId}|${tripId}`;
          if (!lookup.has(key)) lookup.set(key, []);
          lookup.get(key).push({
            routeId,
            directionKey,
            dayType,
            schedule,
            direction: directionsData?.[routeId]?.[directionKey] || null
          });
        }
      }
    }
  }
  return lookup;
}

function getSofiaDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SOFIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value || '';
  return { year: Number(part('year')), month: Number(part('month')), day: Number(part('day')) };
}

function getSofiaDateKey(date) {
  const { year, month, day } = getSofiaDateParts(date);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getSofiaTimeString(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SOFIA_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value || '00';
  return `${part('hour')}:${part('minute')}:${part('second')}`;
}

function getTimeZoneOffsetMs(date, timeZone = SOFIA_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
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

function parseLocalDateTimeToEpochSeconds(value, timeZone = SOFIA_TIME_ZONE) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  // Values with an explicit zone/offset are unambiguous and can be parsed as-is.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  }

  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second = '0', fraction = ''] = match;
  const milliseconds = Number((fraction + '000').slice(0, 3));
  const localAsUtc = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second), milliseconds
  );

  // Solve UTC = local wall time - zone offset. Iterate once more around DST edges.
  let utc = localAsUtc - getTimeZoneOffsetMs(new Date(localAsUtc), timeZone);
  utc = localAsUtc - getTimeZoneOffsetMs(new Date(utc), timeZone);
  return utc / 1000;
}

function parseHmsToEpochSeconds(dateString, hms, timeZone = SOFIA_TIME_ZONE) {
  const date = String(dateString ?? '').trim();
  const time = String(hms ?? '').trim();
  if (!date || !time) return null;
  const match = time.match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return null;

  const dayOffset = Math.floor(hours / 24);
  const hourOfDay = hours % 24;
  const [year, month, day] = date.split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  const calendarDate = new Date(Date.UTC(year, month - 1, day + dayOffset));
  const adjustedDate = `${calendarDate.getUTCFullYear()}-${String(calendarDate.getUTCMonth() + 1).padStart(2, '0')}-${String(calendarDate.getUTCDate()).padStart(2, '0')}`;
  return parseLocalDateTimeToEpochSeconds(
    `${adjustedDate}T${String(hourOfDay).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
    timeZone
  );
}

function optionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('bg-BG')
    .replace(/\s+/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/[.]/g, '');
}

function getStopForRequest(stopCode) {
  const raw = String(stopCode ?? '').trim();
  if (!raw) return null;
  return stopById.get(raw)
    || stopIndexes.byCode.get(raw)
    || null;
}

function selectStaticInfo(routeId, tripId, serviceDate, now, transitlandTrip = {}) {
  const options = tripScheduleLookup.get(`${routeId}|${tripId}`) || [];
  if (!options.length) return null;

  const effectiveDate = String(serviceDate || getSofiaDateKey(now)).slice(0, 10);
  const [year, month, day] = effectiveDate.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dayType = weekday === 0 || weekday === 6 ? 'weekend' : 'weekday';
  const preferred = options.filter(option => option.dayType === dayType);
  const candidates = preferred.length ? preferred : options;

  const targetHeadsign = normalizeText(transitlandTrip.trip_headsign);
  const targetDirectionId = String(transitlandTrip.direction_id ?? '').trim();
  if (targetDirectionId) {
    const exactDirection = candidates.find(option =>
      String(option.direction?.direction_id ?? '').trim() === targetDirectionId
    );
    if (exactDirection) return exactDirection;
  }
  if (targetHeadsign) {
    const exactHeadsign = candidates.find(option =>
      normalizeText(option.direction?.headsign || option.direction?.destination) === targetHeadsign
    );
    if (exactHeadsign) return exactHeadsign;
  }
  return candidates[0] || null;
}

function getTerminalStopId(staticInfo) {
  const pattern = Array.isArray(staticInfo?.direction?.pattern) ? staticInfo.direction.pattern : [];
  const times = Array.isArray(staticInfo?.schedule?.times) ? staticInfo.schedule.times : [];
  for (let index = Math.min(pattern.length, times.length) - 1; index >= 0; index -= 1) {
    if (/^\d{1,3}:\d{2}:\d{2}$/.test(String(times[index] || '').trim())) {
      return String(pattern[index] || '').trim();
    }
  }
  return String(pattern[pattern.length - 1] || '').trim();
}

function getDestinationName(terminalStopId, staticInfo, transitlandTrip, stopHeadSign) {
  const terminal = stopById.get(String(terminalStopId || '').trim());
  return String(
    terminal?.osm_stop_name
    || terminal?.stop_name
    || staticInfo?.direction?.destination
    || staticInfo?.direction?.headsign
    || stopHeadSign
    || transitlandTrip?.trip_headsign
    || ''
  ).trim();
}

function getRouteMeta(routeId, transitlandRoute) {
  const localRoute = routeById.get(String(routeId || '').trim());
  const route = localRoute || (transitlandRoute ? {
    route_id: routeId,
    route_short_name: transitlandRoute.route_short_name,
    route_long_name: transitlandRoute.route_long_name,
    route_type: String(transitlandRoute.route_type ?? ''),
    route_color: transitlandRoute.route_color,
    route_text_color: transitlandRoute.route_text_color
  } : null);
  if (!route) {
    return { id: String(routeId || ''), number: '—', type: 'bus', subtype: '', icon: '', color: '#BE1E2D', textColor: '#FFFFFF' };
  }
  return getRouteMetadata(route) || {
    id: String(route.route_id || routeId || ''),
    number: String(route.route_short_name || '—'),
    type: 'bus', subtype: '', icon: '', color: '#BE1E2D', textColor: '#FFFFFF'
  };
}

function getEventTimestamp(event, fieldPrefix, calendarDate, hmsFallback) {
  if (!event || typeof event !== 'object') return null;
  const utcValue = event[`${fieldPrefix}_utc`];
  if (utcValue) {
    const parsed = Date.parse(String(utcValue));
    if (Number.isFinite(parsed)) return parsed / 1000;
  }
  const localValue = event[`${fieldPrefix}_local`];
  if (localValue) {
    const parsed = parseLocalDateTimeToEpochSeconds(localValue);
    if (parsed !== null) return parsed;
  }
  const hmsValue = event[fieldPrefix];
  return parseHmsToEpochSeconds(calendarDate, hmsValue || hmsFallback);
}

function getDepartureTimestamp(departure, eventType, calendarDate) {
  const event = departure?.[eventType] || {};
  const prefix = 'scheduled';
  const fallbackHms = eventType === 'arrival'
    ? (departure?.arrival_time || departure?.departure_time)
    : (departure?.departure_time || departure?.arrival_time);
  // GTFS HH:MM:SS values are service-day times; this matters for 24:xx
  // departures that are displayed on the following calendar day.
  return getEventTimestamp(event, prefix, departure?.service_date || departure?.date || calendarDate, fallbackHms);
}

function getEstimatedTimestamp(departure, eventType, calendarDate) {
  const event = departure?.[eventType] || {};
  // Do not mistake a scheduled HH:MM:SS value for a realtime estimate.
  return getEventTimestamp(event, 'estimated', departure?.service_date || departure?.date || calendarDate, event.estimated);
}

function makeCourseKey(routeId, tripId, serviceDate, startTime, directionId) {
  return [routeId, tripId, serviceDate, startTime, directionId].map(value => String(value || '').trim()).join('|');
}

function buildTransitlandBoard(response, stop, now = new Date(), options = {}) {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const isMetro = /^M/i.test(String(stop?.stop_id || '')) || /^M/i.test(String(stop?.stop_code || ''));
  const matchingStop = (Array.isArray(response?.stops) ? response.stops : [])
    .find(item => String(item?.stop_id || '').trim() === String(stop.stop_id || '').trim())
    || response?.stops?.[0]
    || null;

  if (!matchingStop) throw new Error('Transitland did not return the requested Sofia stop.');

  const departures = Array.isArray(matchingStop.departures) ? matchingStop.departures : [];
  const grouped = new Map();
  const realtimeCourses = new Map();
  let latestRealtimeTimestamp = null;
  const lookaheadSeconds = Number.isFinite(options.lookaheadSeconds)
    ? options.lookaheadSeconds
    : DEFAULT_LOOKAHEAD_SECONDS;

  for (const departure of departures) {
    const relationship = String(
      departure?.schedule_relationship
      || departure?.trip?.schedule_relationship
      || ''
    ).toUpperCase();

    if (['CANCELED', 'DELETED', 'SKIPPED'].includes(relationship)) continue;

    const trip = departure?.trip || {};
    const transitlandRoute = trip.route || {};
    const routeId = String(transitlandRoute.route_id || '').trim();
    const tripId = String(trip.trip_id || '').trim();
    if (!routeId) continue;

    const serviceDate = String(departure?.service_date || departure?.date || getSofiaDateKey(now)).slice(0, 10);
    const staticInfo = selectStaticInfo(routeId, tripId, serviceDate, now, trip);
    const terminalStopId = getTerminalStopId(staticInfo);
    const directionKey = String(staticInfo?.directionKey || '');
    const directionId = String(staticInfo?.direction?.direction_id ?? trip.direction_id ?? '').trim();
    const startTime = String(staticInfo?.schedule?.start_time || '').trim();
    const destination = getDestinationName(terminalStopId, staticInfo, trip, departure?.stop_headsign);
    const meta = getRouteMeta(routeId, transitlandRoute);

    const eventType = departure?.arrival?.scheduled_local || departure?.arrival?.scheduled_utc
      || departure?.arrival?.scheduled
      ? 'arrival'
      : 'departure';
    const scheduledTimestamp = getDepartureTimestamp(departure, eventType, serviceDate);
    const estimatedTimestamp = (!isMetro && !['STATIC', 'NO_DATA'].includes(relationship))
      ? getEstimatedTimestamp(departure, eventType, serviceDate)
      : null;
    const useRealtime = estimatedTimestamp !== null;
    const timestamp = useRealtime ? estimatedTimestamp : scheduledTimestamp;

    if (!Number.isFinite(timestamp)) continue;
    if (timestamp < nowSeconds || timestamp > nowSeconds + lookaheadSeconds) continue;

    const key = `${routeId}|${terminalStopId || directionKey || normalizeText(destination)}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        route_id: routeId,
        direction_key: directionKey,
        direction_id: directionId,
        terminal_stop_id: terminalStopId,
        destination: destination || '—',
        route_ref: meta.number || transitlandRoute.route_short_name || '—',
        meta,
        realtime: false,
        scheduled: !useRealtime,
        source: 'transitland',
        times: []
      });
    }

    const arrival = {
      timestamp,
      delay: useRealtime
        ? (optionalNumber(departure?.arrival?.estimated_delay)
          ?? optionalNumber(departure?.arrival?.delay))
        : null,
      scheduled: !useRealtime,
      source: useRealtime ? 'transitland-realtime' : 'transitland-static',
      route_id: routeId,
      trip_id: tripId,
      trip_start_date: String(departure?.service_date || serviceDate).replace(/-/g, ''),
      trip_start_time: startTime,
      direction_id: directionId
    };
    const staticTimestamp = getDepartureTimestamp(departure, eventType, serviceDate);
    if (staticTimestamp !== null) arrival.scheduled_time = staticTimestamp;

    const routeGroup = grouped.get(key);
    routeGroup.times.push(arrival);
    if (useRealtime) {
      routeGroup.realtime = true;
      routeGroup.scheduled = false;
      const tripTimestamp = trip.timestamp ? Date.parse(String(trip.timestamp)) / 1000 : null;
      if (Number.isFinite(tripTimestamp)) {
        latestRealtimeTimestamp = latestRealtimeTimestamp === null
          ? tripTimestamp
          : Math.max(latestRealtimeTimestamp, tripTimestamp);
      }
      const courseKey = makeCourseKey(routeId, tripId, arrival.trip_start_date, startTime, directionId);
      realtimeCourses.set(courseKey, {
        route_id: routeId,
        trip_id: tripId,
        trip_start_date: arrival.trip_start_date,
        trip_start_time: startTime,
        direction_id: directionId,
        stop_update_state: 'target-update'
      });
    } else if (trip.timestamp) {
      const tripTimestamp = Date.parse(String(trip.timestamp)) / 1000;
      if (Number.isFinite(tripTimestamp)) {
        latestRealtimeTimestamp = latestRealtimeTimestamp === null
          ? tripTimestamp
          : Math.max(latestRealtimeTimestamp, tripTimestamp);
      }
      const courseKey = makeCourseKey(routeId, tripId, arrival.trip_start_date, startTime, directionId);
      realtimeCourses.set(courseKey, {
        route_id: routeId,
        trip_id: tripId,
        trip_start_date: arrival.trip_start_date,
        trip_start_time: startTime,
        direction_id: directionId,
        stop_update_state: 'unknown'
      });
    }
  }

  const routes = [...grouped.values()]
    .map(route => {
      const unique = new Map();
      for (const time of route.times) {
        const key = `${time.trip_id}|${time.timestamp}`;
        if (!unique.has(key)) unique.set(key, time);
      }
      const times = [...unique.values()]
        .sort((left, right) => left.timestamp - right.timestamp)
        .slice(0, MAX_ARRIVALS_PER_ROUTE);
      return { ...route, times };
    })
    .filter(route => route.times.length)
    .sort((left, right) => left.times[0].timestamp - right.times[0].timestamp);

  return {
    status: routes.length ? 'ok' : 'empty',
    stop_code: String(stop.stop_id || stop.stop_code || ''),
    generated_at: nowSeconds,
    realtime_courses: [...realtimeCourses.values()],
    routes,
    provider: 'transitland',
    provider_cache_status: options.cacheStatus || 'fresh',
    realtime_status: isMetro ? 'not_applicable' : 'available',
    realtime_message: '',
    realtime_feed_timestamp: isMetro ? null : latestRealtimeTimestamp
  };
}

function createTransitlandService(options = {}) {
  const apiKey = String(options.apiKey ?? process.env.TRANSITLAND_API_KEY ?? '').trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const cacheTtlMs = Number.isFinite(options.cacheTtlMs) ? options.cacheTtlMs : DEFAULT_CACHE_TTL_MS;
  const staleTtlMs = Number.isFinite(options.staleTtlMs) ? options.staleTtlMs : DEFAULT_STALE_TTL_MS;
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? options.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  const cache = options.cache || new Map();
  const inFlight = options.inFlight || new Map();

  async function fetchStopDepartures(stopId, date, lookaheadSeconds) {
    if (!apiKey) throw new Error('TRANSITLAND_API_KEY is not configured.');
    if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not provide fetch().');

    const stopKey = `${FEED_ONESTOP_ID}:${stopId}`;
    const url = new URL(`${TRANSITLAND_BASE_URL}/stops/${encodeURIComponent(stopKey)}/departures`);
    url.searchParams.set('date', date);
    url.searchParams.set('next', String(lookaheadSeconds));
    url.searchParams.set('limit', '200');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          apikey: apiKey,
          'User-Agent': 'GTSofia/Transitland integration'
        },
        signal: controller.signal
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Transitland API returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}.`);
      }

      const data = await response.json();
      if (!data || !Array.isArray(data.stops)) {
        throw new Error('Transitland returned an unexpected departures response.');
      }
      const matchingStop = data.stops.find(item => String(item?.stop_id || '').trim() === stopId);
      if (!matchingStop) {
        throw new Error(`Transitland did not resolve GTFS stop_id ${stopId} in Sofia feed.`);
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Transitland request timed out.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getBoard(stopCode, now = new Date()) {
    const stop = getStopForRequest(stopCode);
    if (!stop) throw new Error(`Unknown GTSofia stop: ${String(stopCode || '')}`);
    const stopId = String(stop.stop_id || '').trim();
    if (!stopId) throw new Error('Selected stop has no GTFS stop_id.');

    const date = getSofiaDateKey(now);
    const isMetro = /^M/i.test(stopId) || /^M/i.test(String(stop.stop_code || ''));
    const requestLookahead = isMetro ? METRO_REQUEST_LOOKAHEAD_SECONDS : DEFAULT_LOOKAHEAD_SECONDS;
    const cacheTtlForStop = isMetro ? METRO_CACHE_TTL_MS : cacheTtlMs;
    const cacheKey = `${stopId}|${date}`;
    const nowMs = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && nowMs - cached.fetchedAt < cacheTtlForStop) {
      return buildTransitlandBoard(cached.data, stop, now, { cacheStatus: 'hit' });
    }

    if (inFlight.has(cacheKey)) {
      const shared = await inFlight.get(cacheKey);
      return buildTransitlandBoard(shared.data, stop, now, { cacheStatus: 'coalesced' });
    }

    const pending = fetchStopDepartures(stopId, date, requestLookahead)
      .then(data => {
        cache.set(cacheKey, { data, fetchedAt: Date.now() });
        return { data, fetchedAt: Date.now() };
      })
      .catch(error => {
        const latest = cache.get(cacheKey);
        if (latest && Date.now() - latest.fetchedAt <= staleTtlMs) {
          return { data: latest.data, fetchedAt: latest.fetchedAt, staleError: error };
        }
        throw error;
      })
      .finally(() => inFlight.delete(cacheKey));

    inFlight.set(cacheKey, pending);
    const result = await pending;
    return buildTransitlandBoard(result.data, stop, now, {
      cacheStatus: result.staleError ? 'stale' : 'miss'
    });
  }

  return { getBoard, cache, inFlight };
}


module.exports = {
  createTransitlandService,
  buildTransitlandBoard,
  getSofiaDateKey,
  getSofiaTimeString,
  parseLocalDateTimeToEpochSeconds,
  parseHmsToEpochSeconds,
  DEFAULT_CACHE_TTL_MS,
  METRO_CACHE_TTL_MS,
  METRO_REQUEST_LOOKAHEAD_SECONDS,
  DEFAULT_STALE_TTL_MS
};
