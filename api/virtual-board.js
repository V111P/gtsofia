const { buildVirtualBoard } = require('./virtual-board-service');
const tripsData = require('../data/trips.json');
const stopsData = require('../data/stops.json');

const API_TIMEOUT_MS = 12000;
const MAX_API_ARRIVALS = 100;
const SOFIA_TIME_ZONE = 'Europe/Sofia';

// The API's arrival id is built as `${tripId}-${stopId}-${unixTimestamp}`.
// Resolve the trip against our checked-in GTFS so the locally generated
// timetable, route metadata and OSM destination names remain authoritative.
const TRIP_BY_ID = new Map(
  tripsData
    .filter(trip => trip?.trip_id && trip?.route_id)
    .map(trip => [String(trip.trip_id).trim(), trip])
);

function normalizeStopKey(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const withoutMetroPrefix = raw.replace(/^M/i, '');
  const digits = withoutMetroPrefix.replace(/\D/g, '');
  return digits ? String(Number(digits)) : withoutMetroPrefix.toLowerCase();
}

function findStop(stopCode) {
  const raw = String(stopCode ?? '').trim();
  return stopsData.find(stop =>
    String(stop?.stop_id ?? '').trim() === raw
    || String(stop?.stop_code ?? '').trim() === raw
  ) || null;
}

function isMetroStop(stopCode) {
  const raw = String(stopCode ?? '').trim();
  const stop = findStop(raw);
  return /^M/i.test(String(stop?.stop_id || raw))
    || /^M/i.test(String(stop?.stop_code || ''));
}

function getSofiaDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SOFIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}${get('month')}${get('day')}`;
}

function getSofiaTransportApiBaseUrl() {
  const raw = String(process.env.SOFIA_TRANSPORT_API_URL || '').trim();
  if (!raw) return '';

  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('SOFIA_TRANSPORT_API_URL must use HTTP or HTTPS.');
  }

  return parsed.toString().replace(/\/+$/, '');
}

async function fetchArrivalsFromSofiaTransportApi(publicStopCode) {
  const baseUrl = getSofiaTransportApiBaseUrl();
  if (!baseUrl) {
    throw new Error('SOFIA_TRANSPORT_API_URL is not configured.');
  }

  const url = `${baseUrl}/api/stops/${encodeURIComponent(publicStopCode)}/arrivals?limit=${MAX_API_ARRIVALS}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Sofia Transport API returned invalid JSON.');
    }

    if (!response.ok) {
      throw new Error(
        payload?.error || `Sofia Transport API returned ${response.status}.`
      );
    }

    if (!payload || !Array.isArray(payload.arrivals)) {
      throw new Error('Sofia Transport API response has no arrivals array.');
    }

    return payload.arrivals;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve the original GTFS trip and stop from the arrival id returned by
 * Sofia Transport API. The endpoint merges all GTFS stop_ids sharing a public
 * stop_code (e.g. bus + trolley), so the stop identity is checked after
 * normalizing the source id to the public stop code.
 */
function resolveArrivalIdentity(arrival, publicStopCode) {
  const id = String(arrival?.id || '').trim();
  const arrivalDateMs = typeof arrival?.arrivalDate === 'number'
    ? Number(arrival.arrivalDate)
    : Date.parse(String(arrival?.arrivalDate || ''));

  if (!id || !Number.isFinite(arrivalDateMs) || arrivalDateMs <= 0) return null;

  const arrivalTimestamp = Math.floor(arrivalDateMs / 1000);
  const timestampSuffix = `-${arrivalTimestamp}`;
  if (!id.endsWith(timestampSuffix)) return null;

  const tripAndStop = id.slice(0, -timestampSuffix.length);
  const separator = tripAndStop.lastIndexOf('-');
  if (separator <= 0 || separator === tripAndStop.length - 1) return null;

  const tripId = tripAndStop.slice(0, separator);
  const sourceStopId = tripAndStop.slice(separator + 1);
  const trip = TRIP_BY_ID.get(tripId);
  if (!trip) return null;

  if (normalizeStopKey(sourceStopId) !== normalizeStopKey(publicStopCode)) {
    return null;
  }

  return {
    tripId,
    routeId: String(trip.route_id).trim(),
    timestamp: arrivalTimestamp,
    delay: arrival?.delaySeconds === null || arrival?.delaySeconds === undefined
      || String(arrival.delaySeconds).trim() === ''
      ? null
      : Number(arrival.delaySeconds)
  };
}

function buildRealtimeBoardFromArrivals(arrivals, publicStopCode, now) {
  const byTrip = new Map();
  let unmatchedArrivals = 0;

  for (const arrival of arrivals) {
    const identity = resolveArrivalIdentity(arrival, publicStopCode);
    if (!identity || (identity.delay !== null && !Number.isFinite(identity.delay))) {
      unmatchedArrivals += 1;
      continue;
    }

    if (!byTrip.has(identity.tripId)) {
      byTrip.set(identity.tripId, {
        route_id: identity.routeId,
        trip_id: identity.tripId,
        trip_start_date: getSofiaDateKey(now),
        times: []
      });
    }

    const route = byTrip.get(identity.tripId);
    if (route.route_id !== identity.routeId) {
      unmatchedArrivals += 1;
      continue;
    }

    const scheduledTime = identity.delay === null
      ? null
      : identity.timestamp - identity.delay;
    if (!route.times.some(time => time.timestamp === identity.timestamp)) {
      route.times.push({
        timestamp: identity.timestamp,
        delay: identity.delay,
        scheduled_time: scheduledTime
      });
    }
  }

  return {
    status: byTrip.size ? 'ok' : 'empty',
    stop_code: publicStopCode,
    // Sofia Transport API exposes the prediction timestamps but not the
    // upstream FeedHeader timestamp. Do not misrepresent this as feed time.
    generated_at: Math.floor(now.getTime() / 1000),
    skipped_trips: [],
    realtime_trips: [],
    routes: [...byTrip.values()],
    unmatched_arrivals: unmatchedArrivals
  };
}

function setBoardResponseHeaders(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const stopCode = String(req.query?.stop_code || '').trim();
  if (!stopCode) {
    return res.status(400).json({ error: 'Missing stop_code.' });
  }

  const now = new Date();
  const metro = isMetroStop(stopCode);
  let realtimeBoard = {
    status: 'empty',
    stop_code: stopCode,
    generated_at: Math.floor(now.getTime() / 1000),
    skipped_trips: [],
    realtime_trips: [],
    routes: []
  };
  let realtimeStatus = metro ? 'not_applicable' : 'available';
  let realtimeMessage = '';
  let realtimeMatchedArrivals = 0;
  let realtimeUnmatchedArrivals = 0;

  // Sofia Transport API currently covers buses, trams and trolleybuses.
  // Metro stays schedule-only and continues to use our local GTFS + OSM data.
  if (!metro) {
    try {
      const selectedStop = findStop(stopCode);
      const publicStopCode = String(selectedStop?.stop_code || stopCode).trim();
      if (!publicStopCode) throw new Error('The selected stop has no public stop code.');

      const arrivals = await fetchArrivalsFromSofiaTransportApi(publicStopCode);
      realtimeBoard = buildRealtimeBoardFromArrivals(arrivals, publicStopCode, now);
      realtimeMatchedArrivals = realtimeBoard.routes.reduce(
        (count, route) => count + route.times.length,
        0
      );
      realtimeUnmatchedArrivals = realtimeBoard.unmatched_arrivals;
      delete realtimeBoard.unmatched_arrivals;

      if (realtimeUnmatchedArrivals) {
        console.warn(
          `GTSofia could not map ${realtimeUnmatchedArrivals} Sofia Transport API arrival(s) `
          + `to local GTFS for stop ${stopCode}.`
        );
      }
      if (arrivals.length > 0 && realtimeMatchedArrivals === 0) {
        realtimeStatus = 'unavailable';
        realtimeMessage = 'Realtime информацията не може да бъде съпоставена с локалното разписание — показваме разписанието.';
      }
    } catch (error) {
      realtimeStatus = 'unavailable';
      realtimeMessage = 'Realtime информацията временно не е налична — показваме разписанието.';
      const detail = error?.name === 'AbortError'
        ? 'Sofia Transport API request timed out.'
        : (error?.message || 'Unable to fetch Sofia Transport API arrivals.');
      console.warn(`GTSofia realtime fallback for stop ${stopCode}: ${detail}`);
    }
  }

  try {
    // This remains our local source of truth for static GTFS schedules,
    // calendars, line styling, directions and OSM-first destination names.
    const board = buildVirtualBoard(realtimeBoard, stopCode, now);
    setBoardResponseHeaders(res);
    return res.status(200).json({
      ...board,
      realtime_status: realtimeStatus,
      realtime_message: realtimeMessage,
      // Sofia Transport API does not currently expose FeedHeader.timestamp.
      // Keeping this null prevents the browser from treating request time as
      // proof that the upstream GTFS-RT snapshot itself is fresh.
      realtime_feed_timestamp: null,
      realtime_source: metro ? 'static-gtfs' : 'sofia-transport-api',
      realtime_matched_arrivals: realtimeMatchedArrivals,
      realtime_unmatched_arrivals: realtimeUnmatchedArrivals,
      refreshed_at: Math.floor(Date.now() / 1000)
    });
  } catch (error) {
    const message = error?.message || 'Unable to build the virtual board.';
    setBoardResponseHeaders(res);
    return res.status(500).json({ error: message });
  }
};
