const DEFAULT_TIMEOUT_MS = 12000;
const MAX_FEED_AGE_SECONDS = 150;
const MAX_FEED_FUTURE_SKEW_SECONDS = 60;

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function readEvent(event) {
  if (!event) return null;
  return {
    delay: toFiniteNumber(event.delay),
    time: toFiniteNumber(event.timeUnix ?? event.time_unix ?? event.time),
    scheduledTime: toFiniteNumber(event.scheduledTime ?? event.scheduled_time),
    uncertainty: toFiniteNumber(event.uncertainty),
  };
}

function readTrip(rawTrip, rawTripProperties) {
  if (!rawTrip && !rawTripProperties) return null;
  return {
    tripId: String(rawTrip?.tripId || rawTrip?.trip_id || rawTripProperties?.tripId || rawTripProperties?.trip_id || '').trim(),
    routeId: String(rawTrip?.routeId ?? rawTrip?.route_id ?? '').trim(),
    directionId: String(rawTrip?.directionId ?? rawTrip?.direction_id ?? '').trim(),
    startTime: String(rawTrip?.startTime ?? rawTrip?.start_time ?? rawTripProperties?.startTime ?? rawTripProperties?.start_time ?? '').trim(),
    startDate: String(rawTrip?.startDate ?? rawTrip?.start_date ?? rawTripProperties?.startDate ?? rawTripProperties?.start_date ?? '').trim(),
    scheduleRelationship: toFiniteNumber(rawTrip?.scheduleRelationship ?? rawTrip?.schedule_relationship) ?? 0,
  };
}

function normalizeStopUpdate(update) {
  const stopId = String(update?.stopId ?? update?.stop_id ?? '').trim();
  if (!stopId) return null;
  return {
    stopId,
    stopSequence: toFiniteNumber(update?.stopSequence ?? update?.stop_sequence),
    arrival: readEvent(update?.arrival),
    departure: readEvent(update?.departure),
    scheduleRelationship: toFiniteNumber(update?.scheduleRelationship ?? update?.schedule_relationship) ?? 0,
  };
}

function normalizeTripUpdate(update) {
  const tripProperties = update?.tripProperties ?? update?.trip_properties ?? null;
  const trip = readTrip(update?.trip ?? null, tripProperties);
  if (!trip?.tripId) {
    throw new Error('Sofia Transport API returned a TripUpdate without a trip ID.');
  }

  const rawStops = Array.isArray(update?.stopTimeUpdates)
    ? update.stopTimeUpdates
    : (Array.isArray(update?.stop_time_updates) ? update.stop_time_updates : []);
  return {
    entityId: String(update?.entityId ?? update?.entity_id ?? ''),
    trip,
    tripProperties: tripProperties ? {
      tripId: String(tripProperties.tripId ?? tripProperties.trip_id ?? '').trim(),
      startDate: String(tripProperties.startDate ?? tripProperties.start_date ?? '').trim(),
      startTime: String(tripProperties.startTime ?? tripProperties.start_time ?? '').trim(),
    } : null,
    timestamp: toFiniteNumber(update?.timestampUnix ?? update?.timestamp_unix ?? update?.timestamp),
    delay: toFiniteNumber(update?.delay),
    stopTimeUpdates: rawStops.map(normalizeStopUpdate).filter(Boolean),
  };
}

function normalizeProxyFeed(payload, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!payload || !Array.isArray(payload.tripUpdates)) {
    throw new Error('Sofia Transport API response is missing tripUpdates[].');
  }
  const feedTimestamp = toFiniteNumber(payload.feedTimestamp ?? payload.feed_timestamp);
  if (feedTimestamp === null || feedTimestamp <= 0) {
    throw new Error('Sofia Transport API response has no valid feedTimestamp.');
  }
  const age = nowSeconds - feedTimestamp;
  if (age > MAX_FEED_AGE_SECONDS) {
    throw new Error(`Sofia Transport API returned a stale feed (${age}s old).`);
  }
  if (age < -MAX_FEED_FUTURE_SKEW_SECONDS) {
    throw new Error('Sofia Transport API feed timestamp is too far in the future.');
  }
  const feedIncrementality = toFiniteNumber(payload.feedIncrementality ?? payload.feed_incrementality) ?? 0;
  if (feedIncrementality !== 0) {
    throw new Error('Sofia Transport API returned a differential GTFS-RT feed.');
  }

  return {
    updates: payload.tripUpdates.map(normalizeTripUpdate),
    feedTimestamp: Math.trunc(feedTimestamp),
    provider: 'sofia-transport-api',
  };
}

async function fetchProxyTripUpdates(options = {}) {
  const baseUrl = String(process.env.SOFIA_TRANSPORT_API_URL ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('SOFIA_TRANSPORT_API_URL is not configured.');

  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json' };
    const apiKey = String(process.env.SOFIA_TRANSPORT_PROXY_API_KEY ?? '').trim();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(`${baseUrl}/api/trip-updates`, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`Sofia Transport API returned HTTP ${response.status}.`);
    }
    const payload = await response.json();
    return normalizeProxyFeed(payload);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Sofia Transport API request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  fetchProxyTripUpdates,
  normalizeProxyFeed,
};
