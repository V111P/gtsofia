const routesData = require('../data/routes.json');
const stopsData = require('../data/stops.json');
const tripDestinations = require('../data/trip-destinations.json');
const metroBoardData = require('../data/metro-board.json');
const { getRouteMetadata } = require('../route-metadata');

const SOFIA_TIME_ZONE = 'Europe/Sofia';
const PROXY_TIMEOUT_MS = 40_000;
const MAX_ARRIVALS_PER_LINE = 3;
const MAX_LOOKAHEAD_SECONDS = 2 * 60 * 60;
const PAST_GRACE_MS = 60_000;

const routesById = new Map(
  routesData.map(route => [String(route?.route_id ?? '').trim(), route])
);

function normalizeText(value) {
  return String(value ?? '').trim();
}

function getStopAliases(identifier, stops = stopsData) {
  const requested = normalizeText(identifier);
  const aliases = new Set(requested ? [requested] : []);
  if (!requested) return aliases;

  for (const stop of Array.isArray(stops) ? stops : []) {
    const stopId = normalizeText(stop?.stop_id);
    const stopCode = normalizeText(stop?.stop_code);
    if (stopId === requested || stopCode === requested) {
      if (stopId) aliases.add(stopId);
      if (stopCode) aliases.add(stopCode);
    }
  }
  return aliases;
}

function normalizeStopName(value) {
  return normalizeText(value)
    .normalize('NFKC')
    .toLocaleLowerCase('bg-BG')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function getStopNames(identifier, stops = stopsData) {
  const aliases = getStopAliases(identifier, stops);
  const names = new Set();
  if (!aliases.size) return names;

  const nameFields = [
    'osm_stop_name',
    'osm_name',
    'osm_full_name_bg',
    'stop_name',
    'gtfs_stop_name',
    'name'
  ];

  for (const stop of Array.isArray(stops) ? stops : []) {
    const stopId = normalizeText(stop?.stop_id);
    const stopCode = normalizeText(stop?.stop_code);
    if (!aliases.has(stopId) && !aliases.has(stopCode)) continue;

    for (const field of nameFields) {
      const name = normalizeStopName(stop?.[field]);
      if (name) names.add(name);
    }
  }
  return names;
}

function destinationMatchesBoardStop(destination, terminalStopId, stopAliases, stopNames) {
  const terminalId = normalizeText(terminalStopId);
  if (terminalId && stopAliases.has(terminalId)) return true;

  const normalizedDestination = normalizeStopName(destination);
  return Boolean(normalizedDestination && stopNames.has(normalizedDestination));
}

function getRouteForArrival(arrival) {
  const routeId = normalizeText(arrival?.routeId || arrival?.route_id);
  const routeNumber = normalizeText(arrival?.routeShortName || arrival?.route_short_name);
  const localRoute = routeId ? routesById.get(routeId) : null;
  if (localRoute) return localRoute;

  const matchingByNumber = routeNumber
    ? routesData.filter(route => normalizeText(route?.route_short_name) === routeNumber)
    : [];
  if (matchingByNumber.length === 1) return matchingByNumber[0];

  const routeType = normalizeText(arrival?.routeType || arrival?.route_type) || '3';
  return {
    route_id: routeId || `RT-${routeNumber || 'UNKNOWN'}`,
    route_short_name: routeNumber || routeId || '—',
    route_type: routeType,
    route_color: normalizeText(arrival?.routeColor || arrival?.route_color),
    route_text_color: normalizeText(arrival?.routeTextColor || arrival?.route_text_color)
  };
}

function resolveOsmDestinationName(value, stops = stopsData) {
  const normalized = normalizeStopName(value);
  if (!normalized) return '';
  const fields = [
    'osm_full_name_bg', 'osm_stop_name', 'osm_name', 'stop_name',
    'gtfs_stop_name', 'name'
  ];
  for (const stop of Array.isArray(stops) ? stops : []) {
    const matches = fields.some(field => normalizeStopName(stop?.[field]) === normalized);
    if (!matches) continue;
    for (const field of ['osm_full_name_bg', 'osm_stop_name', 'osm_name', 'name', 'stop_name', 'gtfs_stop_name']) {
      const candidate = normalizeText(stop?.[field]);
      if (candidate) return candidate;
    }
  }
  return normalizeText(value);
}

function mapRealtimeArrivalsToBoard(arrivals, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const stops = Array.isArray(options.stops) ? options.stops : stopsData;
  const stopAliases = options.stopAliases instanceof Set
    ? options.stopAliases
    : getStopAliases(options.stopIdentifier, stops);
  const stopNames = options.stopNames instanceof Set
    ? options.stopNames
    : getStopNames(options.stopIdentifier, stops);
  const destinationLookup = options.tripDestinations || tripDestinations;
  const groups = new Map();
  const seen = new Set();

  for (const arrival of Array.isArray(arrivals) ? arrivals : []) {
    if (!arrival) continue;
    const isRealtime = arrival.isRealtime === true || arrival.is_realtime === true || arrival.source === 'realtime';
    const isScheduled = arrival.isScheduled === true || arrival.is_scheduled === true
      || arrival.scheduled === true || arrival.source === 'schedule';
    if (!isRealtime && !isScheduled) continue;

    const dateValue = arrival.arrivalDate || arrival.arrival_date || arrival.estimatedTime;
    const timestampMs = Date.parse(dateValue || '');
    if (!Number.isFinite(timestampMs)) continue;
    if (timestampMs < nowMs - PAST_GRACE_MS) continue;
    if (timestampMs > nowMs + MAX_LOOKAHEAD_SECONDS * 1000) continue;

    const route = getRouteForArrival(arrival);
    const meta = getRouteMetadata(route);
    // Metro remains on its separate official local timetable path.
    if (meta?.type === 'metro') continue;

    const routeId = normalizeText(route.route_id);
    const routeNumber = normalizeText(route.route_short_name);
    const tripId = normalizeText(arrival.tripId || arrival.trip_id);
    if (!routeId || !routeNumber) continue;

    const arrivalId = normalizeText(arrival.id)
      || `${tripId}|${routeId}|${timestampMs}|${isRealtime ? 'rt' : 'schedule'}`;
    if (seen.has(arrivalId)) continue;
    seen.add(arrivalId);

    const terminal = tripId ? destinationLookup[tripId] : null;
    const terminalStopId = normalizeText(arrival.terminalStopId || arrival.terminal_stop_id || terminal?.terminal_stop_id);
    const realtimeDestinationCandidates = isRealtime
      ? [arrival.headsign, arrival.destination, arrival.stopHeadsign].map(normalizeText).filter(Boolean)
      : [];
    const realtimeDestinationMatches = realtimeDestinationCandidates.some(candidate =>
      destinationMatchesBoardStop(candidate, '', stopAliases, stopNames)
    );
    const staticTerminalMatches = Boolean(
      (terminalStopId && stopAliases.has(terminalStopId))
      || destinationMatchesBoardStop(terminal?.destination || arrival.destination, '', stopAliases, stopNames)
    );

    // A realtime headsign describes this particular trip instance and takes
    // precedence over the full-route static destination. Scheduled fallback
    // rows use their own generated partial/full trip terminal.
    const destinationIsBoardStop = realtimeDestinationCandidates.length
      ? realtimeDestinationMatches
      : staticTerminalMatches;

    // A course ending at the board stop is not an arrival there: remove the
    // complete course (line, destination and all its times) for both sources.
    if (destinationIsBoardStop) continue;

    const realtimeDestination = realtimeDestinationCandidates.length
      ? resolveOsmDestinationName(realtimeDestinationCandidates[0], stops)
      : '';
    const destination = realtimeDestination
      || normalizeText(terminal?.destination)
      || normalizeText(arrival.destination)
      || normalizeText(arrival.headsign);
    const groupKey = `${routeId}|${destination}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        route_id: routeId,
        route_ref: routeNumber,
        destination,
        headsign: destination,
        meta,
        realtime: false,
        scheduled: false,
        times: []
      });
    }

    const rawDelay = arrival.delaySeconds ?? arrival.delay_seconds ?? arrival.delay;
    const delay = rawDelay === null || rawDelay === undefined || rawDelay === ''
      ? null
      : Number(rawDelay);
    const source = isRealtime ? 'realtime' : 'schedule';

    const group = groups.get(groupKey);
    group.realtime ||= isRealtime;
    group.scheduled ||= isScheduled;
    group.times.push({
      timestamp: Math.floor(timestampMs / 1000),
      delay: Number.isFinite(delay) ? delay : null,
      scheduled: isScheduled,
      source,
      realtime: isRealtime,
      route_id: routeId,
      trip_id: tripId,
      realtime_trip_id: isRealtime ? tripId : '',
      arrival_id: arrivalId
    });
  }

  return [...groups.values()]
    .map(route => ({
      ...route,
      times: [...new Map(route.times
        .sort((left, right) => left.timestamp - right.timestamp)
        .map(time => [time.arrival_id, time])).values()]
        .slice(0, MAX_ARRIVALS_PER_LINE)
    }))
    .filter(route => route.times.length > 0)
    .sort((left, right) => left.times[0].timestamp - right.times[0].timestamp);
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
    minute: Number(values.minute),
    second: Number(values.second),
    dateKey: `${values.year}-${values.month}-${values.day}`
  };
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

function parseGtfsTime(value) {
  const match = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(normalizeText(value));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function dateKeyOffset(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function getMetroDayType(dateKey, calendar = metroBoardData.calendar) {
  const configured = calendar?.dateTypes?.[dateKey] || calendar?.dateOverrides?.[dateKey];
  if (configured === 'weekday' || configured === 'weekend') return configured;
  const [year, month, day] = dateKey.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6 ? 'weekend' : 'weekday';
}

function scheduledTimeToEpoch(dateKey, seconds) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day) + seconds * 1000;
  const offsetMinutes = getSofiaUtcOffsetMinutes(localAsUtc);
  return localAsUtc - offsetMinutes * 60_000;
}

function buildMetroScheduleRoutes(stopIdentifier, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const metroData = options.metroData || metroBoardData;
  const stops = options.stops || stopsData;
  const aliases = options.stopAliases instanceof Set
    ? options.stopAliases
    : getStopAliases(stopIdentifier, stops);
  const matchingDirections = [];

  if (!aliases.size) return { isMetroStation: false, routes: [] };

  for (const route of Object.values(metroData?.routes || {})) {
    for (const [directionKey, direction] of Object.entries(route?.directions || {})) {
      const stopIndex = (direction.stop_ids || []).findIndex(stopId => aliases.has(String(stopId)));
      if (stopIndex >= 0) matchingDirections.push({ route, directionKey, direction, stopIndex });
    }
  }

  if (!matchingDirections.length) return { isMetroStation: false, routes: [] };

  const nowParts = localDateParts(nowMs);
  const serviceDates = [{ dateKey: nowParts.dateKey, previousDay: false }];
  // GTFS may encode after-midnight service against the previous service date (24:xx).
  if (nowParts.hour < 4) {
    serviceDates.push({ dateKey: dateKeyOffset(nowParts.dateKey, -1), previousDay: true });
  }

  const output = [];
  for (const match of matchingDirections) {
    const { route, direction, directionKey, stopIndex } = match;
    const metaRoute = routesById.get(route.route_id) || {
      route_id: route.route_id,
      route_short_name: route.route_short_name,
      route_type: route.route_type,
      route_color: route.route_color,
      route_text_color: route.route_text_color
    };
    const meta = getRouteMetadata(metaRoute);
    const stopIds = Array.isArray(direction.stop_ids) ? direction.stop_ids : [];
    const terminalStopId = normalizeText(direction.terminal_stop_id || stopIds[stopIds.length - 1]);

    // Same terminal rule for every source and mode: if this direction ends at
    // the station currently open on the board, omit the entire arrival row and
    // all of its static times. The opposite direction remains visible.
    if (terminalStopId && aliases.has(terminalStopId)) continue;

    const destination = normalizeText(direction.destination);
    const times = [];

    for (const serviceDate of serviceDates) {
      const dayType = getMetroDayType(serviceDate.dateKey, metroData.calendar);
      const courses = Array.isArray(direction[dayType]) ? direction[dayType] : [];

      for (const course of courses) {
        const timeText = course?.times?.[stopIndex];
        const seconds = parseGtfsTime(timeText);
        if (seconds === null) continue;
        if (serviceDate.previousDay && seconds < 24 * 60 * 60) continue;

        const timestampMs = scheduledTimeToEpoch(serviceDate.dateKey, seconds);
        if (timestampMs < nowMs - PAST_GRACE_MS) continue;
        if (timestampMs > nowMs + MAX_LOOKAHEAD_SECONDS * 1000) continue;

        const tripId = normalizeText(course.original_trip_id);
        times.push({
          timestamp: Math.floor(timestampMs / 1000),
          delay: null,
          scheduled: true,
          source: 'schedule',
          realtime: false,
          route_id: route.route_id,
          trip_id: tripId,
          arrival_id: `${route.route_id}|${directionKey}|${tripId}|${timestampMs}`
        });
      }
    }

    times.sort((left, right) => left.timestamp - right.timestamp);
    const uniqueTimes = [...new Map(times.map(time => [time.arrival_id, time])).values()]
      .slice(0, MAX_ARRIVALS_PER_LINE);
    if (!uniqueTimes.length) continue;

    output.push({
      route_id: route.route_id,
      route_ref: normalizeText(route.route_short_name) || route.route_id,
      destination,
      headsign: destination,
      meta,
      realtime: false,
      scheduled: true,
      direction_key: directionKey,
      times: uniqueTimes
    });
  }

  output.sort((left, right) => left.times[0].timestamp - right.times[0].timestamp);
  return { isMetroStation: true, routes: output };
}

function setHeaders(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

async function fetchProxyArrivals(stopIdentifier, options = {}) {
  const proxyBaseUrl = normalizeText(options.proxyBaseUrl || process.env.SOFIA_REALTIME_PROXY_URL)
    .replace(/\/+$/, '');
  if (!proxyBaseUrl) {
    const error = new Error('SOFIA_REALTIME_PROXY_URL is not configured.');
    error.statusCode = 503;
    throw error;
  }

  const url = new URL(
    `/api/stops/${encodeURIComponent(stopIdentifier)}/arrivals`,
    proxyBaseUrl
  );
  url.searchParams.set('limit', '100');

  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    cache: 'no-store'
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(
      `Realtime proxy returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`
    );
    error.statusCode = 502;
    throw error;
  }

  const payload = await response.json();
  if (!payload || !Array.isArray(payload.arrivals)) {
    const error = new Error('Realtime proxy returned an invalid arrivals response.');
    error.statusCode = 502;
    throw error;
  }
  return payload;
}

async function handler(req, res) {
  setHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const stopIdentifier = normalizeText(req.query?.stop_id || req.query?.stop_code);
  if (!stopIdentifier) return res.status(400).json({ error: 'Missing stop_id or stop_code.' });

  const nowMs = Date.now();
  const refreshedAt = Math.floor(nowMs / 1000);

  // Metro has no usable RT feed. Its virtual-board rows come from the
  // published metro timetable and are explicitly marked as scheduled.
  const metroBoard = buildMetroScheduleRoutes(stopIdentifier, { nowMs });
  if (metroBoard.isMetroStation) {
    const routes = metroBoard.routes;
    return res.status(200).json({
      status: routes.length ? 'ok' : 'empty',
      board_mode: 'metro-schedule',
      stop_code: stopIdentifier,
      stop_identifier: stopIdentifier,
      generated_at: refreshedAt,
      refreshed_at: refreshedAt,
      realtime_status: 'not_applicable',
      provider: 'GT Sofia official GTFS timetable',
      routes
    });
  }

  try {
    const proxyPayload = await fetchProxyArrivals(stopIdentifier);
    const routes = mapRealtimeArrivalsToBoard(proxyPayload.arrivals, {
      nowMs,
      stopIdentifier
    });
    const feedTimestamp = Number(proxyPayload.feedTimestamp);
    const realtimeAvailable = proxyPayload.realtimeAvailable !== false;
    const realtimeMessage = realtimeAvailable
      ? ''
      : 'RT информацията временно не е налична; показваме времената по разписание.';

    return res.status(200).json({
      status: routes.length ? 'ok' : 'empty',
      board_mode: 'realtime-with-schedule-fallback',
      stop_code: stopIdentifier,
      stop_identifier: stopIdentifier,
      generated_at: Number.isFinite(feedTimestamp) && feedTimestamp > 0 ? feedTimestamp : null,
      refreshed_at: refreshedAt,
      realtime_feed_timestamp: Number.isFinite(feedTimestamp) && feedTimestamp > 0 ? feedTimestamp : null,
      realtime_status: realtimeAvailable ? 'available' : 'unavailable',
      realtime_message: realtimeMessage,
      realtime_count: Number(proxyPayload.realtimeCount) || routes.reduce((sum, route) =>
        sum + route.times.filter(time => time.source === 'realtime').length, 0),
      scheduled_count: Number(proxyPayload.scheduledCount) || routes.reduce((sum, route) =>
        sum + route.times.filter(time => time.source === 'schedule').length, 0),
      provider: 'Sofia Traffic GTFS-RT + GTFS timetable',
      routes
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 502;
    const message = statusCode === 503
      ? 'RT proxy не е конфигуриран. Добави SOFIA_REALTIME_PROXY_URL във Vercel.'
      : 'Realtime услугата и резервното разписание временно не са налични.';
    console.warn(`GT Sofia realtime proxy error for stop ${stopIdentifier}:`, error?.message || error);

    return res.status(statusCode).json({
      status: 'empty',
      board_mode: 'realtime',
      stop_code: stopIdentifier,
      stop_identifier: stopIdentifier,
      generated_at: null,
      refreshed_at: refreshedAt,
      realtime_status: 'unavailable',
      realtime_message: message,
      routes: [],
      error: message
    });
  }
}

module.exports = handler;
module.exports.mapRealtimeArrivalsToBoard = mapRealtimeArrivalsToBoard;
module.exports.resolveOsmDestinationName = resolveOsmDestinationName;
module.exports.buildMetroScheduleRoutes = buildMetroScheduleRoutes;
module.exports.getStopAliases = getStopAliases;
module.exports.fetchProxyArrivals = fetchProxyArrivals;
