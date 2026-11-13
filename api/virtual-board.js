const routesData = require('../data/routes.json');
const stopsData = require('../data/stops.json');
const { getRouteMetadata } = require('../route-metadata');

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

function mapRealtimeArrivalsToBoard(arrivals, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const groups = new Map();
  const seen = new Set();

  for (const arrival of Array.isArray(arrivals) ? arrivals : []) {
    if (!arrival || !(arrival.isRealtime === true || arrival.is_realtime === true)) continue;

    const dateValue = arrival.arrivalDate || arrival.arrival_date || arrival.estimatedTime;
    const timestampMs = Date.parse(dateValue || '');
    if (!Number.isFinite(timestampMs)) continue;
    if (timestampMs < nowMs - PAST_GRACE_MS) continue;
    if (timestampMs > nowMs + MAX_LOOKAHEAD_SECONDS * 1000) continue;

    const route = getRouteForArrival(arrival);
    const routeId = normalizeText(route.route_id);
    const routeNumber = normalizeText(route.route_short_name);
    const destination = normalizeText(arrival.headsign || arrival.destination || arrival.stopHeadsign);
    if (!routeId || !routeNumber) continue;

    const arrivalId = normalizeText(arrival.id)
      || `${normalizeText(arrival.tripId || arrival.trip_id)}|${routeId}|${timestampMs}`;
    if (seen.has(arrivalId)) continue;
    seen.add(arrivalId);

    const groupKey = `${routeId}|${destination}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        route_id: routeId,
        route_ref: routeNumber,
        destination,
        headsign: destination,
        meta: getRouteMetadata(route),
        realtime: true,
        times: []
      });
    }

    const rawDelay = arrival.delaySeconds ?? arrival.delay_seconds ?? arrival.delay;
    const delay = rawDelay === null || rawDelay === undefined || rawDelay === ''
      ? null
      : Number(rawDelay);

    groups.get(groupKey).times.push({
      timestamp: Math.floor(timestampMs / 1000),
      delay: Number.isFinite(delay) ? delay : null,
      scheduled: false,
      source: 'realtime',
      realtime: true,
      route_id: routeId,
      trip_id: normalizeText(arrival.tripId || arrival.trip_id),
      realtime_trip_id: normalizeText(arrival.tripId || arrival.trip_id),
      arrival_id: arrivalId
    });
  }

  return [...groups.values()]
    .map(route => ({
      ...route,
      times: route.times
        .sort((left, right) => left.timestamp - right.timestamp)
        .slice(0, MAX_ARRIVALS_PER_LINE)
    }))
    .filter(route => route.times.length > 0)
    .sort((left, right) => left.times[0].timestamp - right.times[0].timestamp);
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


  try {
    const proxyPayload = await fetchProxyArrivals(stopIdentifier);
    const routes = mapRealtimeArrivalsToBoard(proxyPayload.arrivals, { nowMs });
    const feedTimestamp = Number(proxyPayload.feedTimestamp);

    return res.status(200).json({
      status: routes.length ? 'ok' : 'empty',
      stop_code: stopIdentifier,
      stop_identifier: stopIdentifier,
      generated_at: Number.isFinite(feedTimestamp) && feedTimestamp > 0 ? feedTimestamp : null,
      refreshed_at: refreshedAt,
      realtime_feed_timestamp: Number.isFinite(feedTimestamp) && feedTimestamp > 0 ? feedTimestamp : null,
      realtime_status: 'available',
      realtime_message: '',
      provider: 'Sofia Traffic GTFS-RT',
      realtime_only: true,
      routes
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 502;
    const message = statusCode === 503
      ? 'RT proxy не е конфигуриран. Добави SOFIA_REALTIME_PROXY_URL във Vercel.'
      : 'Realtime услугата временно не е налична. Не показваме времена от разписанието.';
    console.warn(`GT Sofia realtime proxy error for stop ${stopIdentifier}:`, error?.message || error);

    return res.status(statusCode).json({
      status: 'empty',
      stop_code: stopIdentifier,
      stop_identifier: stopIdentifier,
      generated_at: null,
      refreshed_at: refreshedAt,
      realtime_status: 'unavailable',
      realtime_message: message,
      realtime_only: true,
      routes: [],
      error: message
    });
  }
}

module.exports = handler;
module.exports.mapRealtimeArrivalsToBoard = mapRealtimeArrivalsToBoard;
module.exports.fetchProxyArrivals = fetchProxyArrivals;
