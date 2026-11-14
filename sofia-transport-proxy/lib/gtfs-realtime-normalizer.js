/**
 * Pure normalization of decoded GTFS-Realtime messages to a stable JSON model.
 * Kept separate from protobuf/network code so field preservation is testable.
 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function unixSeconds(value) {
  const number = numberOrNull(value);
  return number === null ? null : Math.trunc(number);
}

function normalizeEvent(event) {
  if (!event) return null;
  return {
    delay: numberOrNull(event.delay),
    time: unixSeconds(event.time),
    scheduledTime: unixSeconds(event.scheduledTime ?? event.scheduled_time),
    uncertainty: numberOrNull(event.uncertainty),
  };
}

function normalizeTripDescriptor(descriptor) {
  if (!descriptor) return null;
  return {
    tripId: String(descriptor.tripId ?? descriptor.trip_id ?? '').trim(),
    routeId: String(descriptor.routeId ?? descriptor.route_id ?? '').trim(),
    directionId: descriptor.directionId === undefined && descriptor.direction_id === undefined
      ? ''
      : String(descriptor.directionId ?? descriptor.direction_id),
    startTime: String(descriptor.startTime ?? descriptor.start_time ?? '').trim(),
    startDate: String(descriptor.startDate ?? descriptor.start_date ?? '').trim(),
    scheduleRelationship: numberOrNull(descriptor.scheduleRelationship ?? descriptor.schedule_relationship) ?? 0,
  };
}

function normalizeTripProperties(properties) {
  if (!properties) return null;
  return {
    tripId: String(properties.tripId ?? properties.trip_id ?? '').trim(),
    startDate: String(properties.startDate ?? properties.start_date ?? '').trim(),
    startTime: String(properties.startTime ?? properties.start_time ?? '').trim(),
  };
}

function normalizeStopTimeUpdate(update) {
  const stopId = String(update.stopId ?? update.stop_id ?? '').trim();
  if (!stopId) return null;
  return {
    stopId,
    stopSequence: numberOrNull(update.stopSequence ?? update.stop_sequence),
    arrival: normalizeEvent(update.arrival),
    departure: normalizeEvent(update.departure),
    scheduleRelationship: numberOrNull(update.scheduleRelationship ?? update.schedule_relationship) ?? 0,
  };
}

export function normalizeDecodedFeed(feed, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = feed?.header ?? {};
  const feedTimestamp = unixSeconds(header.timestamp);
  const feedIncrementality = numberOrNull(header.incrementality) ?? 0;
  if (feedIncrementality !== 0) {
    throw new Error('GTFS-RT differential feed is not supported by this stateless proxy.');
  }
  if (!feedTimestamp || feedTimestamp <= 0) {
    throw new Error('GTFS-RT feed has no valid timestamp.');
  }

  const age = nowSeconds - feedTimestamp;
  if (age > 150) throw new Error(`GTFS-RT feed is stale (${age}s old).`);
  if (age < -60) throw new Error('GTFS-RT feed timestamp is too far in the future.');

  const entities = feed.entity ?? feed.entities ?? [];
  const tripUpdates = [];
  for (const entity of entities) {
    if (entity.isDeleted ?? entity.is_deleted) continue;
    const update = entity.tripUpdate ?? entity.trip_update;
    if (!update) continue;

    const trip = normalizeTripDescriptor(update.trip);
    const tripProperties = normalizeTripProperties(update.tripProperties ?? update.trip_properties);
    if (!trip && !tripProperties) continue;

    const rawStops = update.stopTimeUpdate ?? update.stop_time_update ?? [];
    const stopTimeUpdates = rawStops.map(normalizeStopTimeUpdate).filter(Boolean);
    tripUpdates.push({
      entityId: String(entity.id ?? ''),
      trip,
      tripProperties,
      timestamp: unixSeconds(update.timestamp),
      delay: numberOrNull(update.delay),
      stopTimeUpdates,
    });
  }

  return { feedTimestamp, feedIncrementality, tripUpdates };
}
