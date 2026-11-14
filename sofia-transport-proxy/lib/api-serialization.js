function isoFromSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function serializeEvent(event) {
  if (!event) return null;
  return {
    delay: event.delay ?? null,
    time: isoFromSeconds(event.time),
    timeUnix: event.time ?? null,
    scheduledTime: event.scheduledTime ?? null,
    uncertainty: event.uncertainty ?? null,
  };
}

export function serializeTripUpdate(update) {
  const timestamp = update.timestamp ?? null;
  return {
    entityId: update.entityId,
    tripId: update.trip?.tripId ?? update.tripProperties?.tripId ?? '',
    routeId: update.trip?.routeId ?? null,
    timestamp: isoFromSeconds(timestamp),
    timestampUnix: timestamp,
    trip: update.trip,
    tripProperties: update.tripProperties,
    delay: update.delay,
    stopTimeUpdates: update.stopTimeUpdates.map((stop) => ({
      stopId: stop.stopId,
      stopSequence: stop.stopSequence,
      arrival: serializeEvent(stop.arrival),
      departure: serializeEvent(stop.departure),
      scheduleRelationship: stop.scheduleRelationship,
    })),
  };
}

export function serializeFeed(feed) {
  return {
    feedTimestamp: feed.feedTimestamp,
    feedTimestampIso: isoFromSeconds(feed.feedTimestamp),
    feedIncrementality: feed.feedIncrementality,
    tripUpdates: feed.tripUpdates.map(serializeTripUpdate),
    count: feed.tripUpdates.length,
  };
}
