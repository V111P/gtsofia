const { buildVirtualBoard } = require('./virtual-board-service');
const tripsData = require('../data/trips.json');
const stopsData = require('../data/stops.json');

// Trinmo is used only as the realtime TripUpdates source. Static GTFS data
// remains the daily snapshot generated from the official Sofia Traffic API.
// Keep the URL configurable so the provider can be changed without editing code.
const FEED_URL = process.env.GTSOFIA_TRIP_UPDATES_URL
  || 'https://trinmo.org/gtfs-data/trip-updates';
const FEED_TIMEOUT_MS = 15000;
const MAX_FEED_AGE_SECONDS = 120;
const MAX_FEED_FUTURE_SKEW_SECONDS = 60;

const MAX_RESULTS_PER_ROUTE = 3;
const LOOK_AHEAD_SECONDS = 2 * 60 * 60;
// Retain a small tolerance for feed/clock jitter, but not a full minute of stale arrivals.
const REALTIME_PAST_GRACE_SECONDS = 0;

const TEXT_DECODER = new TextDecoder();

const ROUTE_ID_BY_TRIP_ID = new Map();
for (const trip of tripsData) {
  const tripId = String(trip?.trip_id ?? '').trim();
  const routeId = String(trip?.route_id ?? '').trim();
  if (tripId && routeId && !ROUTE_ID_BY_TRIP_ID.has(tripId)) {
    ROUTE_ID_BY_TRIP_ID.set(tripId, routeId);
  }
}

// Simultaneous requests may share one upstream download. The result is not
// retained after the request: each scheduled or manual refresh gets a fresh feed.
let feedFetchPromise = null;

// GTFS-Realtime TripDescriptor.schedule_relationship.
const TRIP_RELATIONSHIP = Object.freeze({
  SCHEDULED: 0,
  ADDED: 1,          // deprecated; keep for backwards-compatible producers
  UNSCHEDULED: 2,
  CANCELED: 3,
  REPLACEMENT: 5,
  DUPLICATED: 6,
  DELETED: 7,
  NEW: 8
});

const STOP_RELATIONSHIP = Object.freeze({
  SCHEDULED: 0,
  SKIPPED: 1,
  NO_DATA: 2,
  UNSCHEDULED: 3
});

const TRIP_RELATIONSHIP_NAME = Object.freeze(
  Object.fromEntries(
    Object.entries(TRIP_RELATIONSHIP)
      .map(([name, value]) => [value, name])
  )
);

const STOP_RELATIONSHIP_NAME = Object.freeze(
  Object.fromEntries(
    Object.entries(STOP_RELATIONSHIP)
      .map(([name, value]) => [value, name])
  )
);

function readVarint(bytes, state) {
  let value = 0n;
  for (let byteIndex = 0; byteIndex < 10; byteIndex++) {
    if (state.index >= bytes.length) {
      throw new Error('Truncated protobuf varint.');
    }

    const byte = bytes[state.index++];
    // A protobuf uint64 uses at most ten bytes; only bit 0 may be set in
    // byte ten. Reject malformed/overflowing values instead of truncating.
    if (byteIndex === 9 && (byte & 0xfe) !== 0) {
      throw new Error('Invalid protobuf varint.');
    }

    value |= BigInt(byte & 0x7f) << BigInt(byteIndex * 7);

    if ((byte & 0x80) === 0) {
      return value;
    }
  }

  throw new Error('Invalid protobuf varint.');
}

function readField(bytes, state) {
  const tag = readVarint(bytes, state);
  const fieldNumber = Number(tag >> 3n);
  const wireType = Number(tag & 7n);

  if (!fieldNumber || fieldNumber > 0x1fffffff) {
    throw new Error('Invalid protobuf field number.');
  }

  if (wireType === 0) {
    return {
      fieldNumber,
      wireType,
      value: readVarint(bytes, state)
    };
  }

  if (wireType === 1) {
    const end = state.index + 8;

    if (end > bytes.length) {
      throw new Error('Truncated fixed64 field.');
    }

    const value = bytes.subarray(
      state.index,
      end
    );

    state.index = end;

    return {
      fieldNumber,
      wireType,
      value
    };
  }

  if (wireType === 2) {
    const length = Number(
      readVarint(bytes, state)
    );

    if (
      !Number.isSafeInteger(length)
      || length < 0
    ) {
      throw new Error('Invalid protobuf length.');
    }

    const end =
      state.index + length;

    if (end > bytes.length) {
      throw new Error(
        'Truncated length-delimited field.'
      );
    }

    const value = bytes.subarray(
      state.index,
      end
    );

    state.index = end;

    return {
      fieldNumber,
      wireType,
      value
    };
  }

  if (wireType === 5) {
    const end = state.index + 4;

    if (end > bytes.length) {
      throw new Error(
        'Truncated fixed32 field.'
      );
    }

    const value = bytes.subarray(
      state.index,
      end
    );

    state.index = end;

    return {
      fieldNumber,
      wireType,
      value
    };
  }

  throw new Error(
    `Unsupported protobuf wire type: ${wireType}`
  );
}

function decodeString(bytes) {
  return TEXT_DECODER.decode(bytes);
}

function toSignedInt32(value) {
  const n = Number(
    BigInt.asUintN(32, value)
  );

  return n >= 0x80000000
    ? n - 0x100000000
    : n;
}

function decodeTripDescriptor(bytes) {
  const state = { index: 0 };

  const trip = {
    tripId: '',
    routeId: '',
    directionId: '',
    startTime: '',
    startDate: '',
    scheduleRelationship:
      TRIP_RELATIONSHIP.SCHEDULED
  };

  while (state.index < bytes.length) {
    const field = readField(
      bytes,
      state
    );

    if (
      field.fieldNumber === 1
      && field.wireType === 2
    ) {
      trip.tripId =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 2
      && field.wireType === 2
    ) {
      trip.startTime =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 3
      && field.wireType === 2
    ) {
      trip.startDate =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 4
      && field.wireType === 0
    ) {
      trip.scheduleRelationship =
        Number(field.value);
    } else if (
      field.fieldNumber === 5
      && field.wireType === 2
    ) {
      trip.routeId =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 6
      && field.wireType === 0
    ) {
      trip.directionId =
        String(Number(field.value));
    }
  }

  return trip;
}

function decodeStopTimeEvent(bytes) {
  const state = { index: 0 };

  const event = {
    delay: null,
    time: null,
    scheduledTime: null,
    uncertainty: null
  };

  while (state.index < bytes.length) {
    const field = readField(
      bytes,
      state
    );

    if (
      field.fieldNumber === 1
      && field.wireType === 0
    ) {
      event.delay =
        toSignedInt32(field.value);
    } else if (
      field.fieldNumber === 2
      && field.wireType === 0
    ) {
      const raw = field.value;

      if (
        raw > BigInt(
          Number.MAX_SAFE_INTEGER
        )
      ) {
        throw new Error(
          'GTFS-RT timestamp exceeds JavaScript safe integer range.'
        );
      }

      event.time = Number(raw);
    } else if (
      field.fieldNumber === 3
      && field.wireType === 0
    ) {
      const raw = field.value;

      if (
        raw > BigInt(
          Number.MAX_SAFE_INTEGER
        )
      ) {
        throw new Error(
          'GTFS-RT uncertainty exceeds JavaScript safe integer range.'
        );
      }

      // GTFS-Realtime StopTimeEvent.uncertainty is field 3. Treating this
      // small value as scheduled_time corrupts inferred delays and can make
      // an otherwise valid realtime prediction look impossibly far in the
      // past or future.
      event.uncertainty = Number(raw);
    } else if (
      field.fieldNumber === 4
      && field.wireType === 0
    ) {
      const raw = field.value;

      if (
        raw > BigInt(
          Number.MAX_SAFE_INTEGER
        )
      ) {
        throw new Error(
          'GTFS-RT scheduled timestamp exceeds JavaScript safe integer range.'
        );
      }

      // scheduled_time is field 4 in the current GTFS-Realtime schema.
      event.scheduledTime = Number(raw);
    }
  }

  return event;
}

function decodeStopTimeUpdate(bytes) {
  const state = { index: 0 };

  const update = {
    stopSequence: null,
    stopId: '',
    arrival: null,
    departure: null,
    scheduleRelationship:
      STOP_RELATIONSHIP.SCHEDULED
  };

  while (state.index < bytes.length) {
    const field = readField(
      bytes,
      state
    );

    if (
      field.fieldNumber === 1
      && field.wireType === 0
    ) {
      update.stopSequence =
        Number(field.value);
    } else if (
      field.fieldNumber === 2
      && field.wireType === 2
    ) {
      update.arrival =
        decodeStopTimeEvent(
          field.value
        );
    } else if (
      field.fieldNumber === 3
      && field.wireType === 2
    ) {
      update.departure =
        decodeStopTimeEvent(
          field.value
        );
    } else if (
      field.fieldNumber === 4
      && field.wireType === 2
    ) {
      update.stopId =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 5
      && field.wireType === 0
    ) {
      update.scheduleRelationship =
        Number(field.value);
    }
  }

  return update;
}

function decodeTripProperties(bytes) {
  const state = { index: 0 };

  const result = {
    tripId: '',
    startDate: '',
    startTime: ''
  };

  while (state.index < bytes.length) {
    const field = readField(
      bytes,
      state
    );

    if (
      field.fieldNumber === 1
      && field.wireType === 2
    ) {
      result.tripId =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 2
      && field.wireType === 2
    ) {
      result.startDate =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 3
      && field.wireType === 2
    ) {
      result.startTime =
        decodeString(field.value);
    }
  }

  return result;
}

function decodeTripUpdate(bytes) {
  const state = { index: 0 };

  const result = {
    trip: null,
    stopTimeUpdates: [],
    timestamp: null,
    delay: null,
    tripProperties: null
  };

  while (state.index < bytes.length) {
    const field = readField(
      bytes,
      state
    );

    if (
      field.fieldNumber === 1
      && field.wireType === 2
    ) {
      result.trip =
        decodeTripDescriptor(
          field.value
        );
    } else if (
      field.fieldNumber === 2
      && field.wireType === 2
    ) {
      result.stopTimeUpdates.push(
        decodeStopTimeUpdate(
          field.value
        )
      );
    } else if (
      field.fieldNumber === 4
      && field.wireType === 0
    ) {
      const raw = field.value;

      if (
        raw <= BigInt(
          Number.MAX_SAFE_INTEGER
        )
      ) {
        result.timestamp =
          Number(raw);
      }
    } else if (
      field.fieldNumber === 5
      && field.wireType === 0
    ) {
      result.delay =
        toSignedInt32(field.value);
    } else if (
      field.fieldNumber === 6
      && field.wireType === 2
    ) {
      result.tripProperties =
        decodeTripProperties(
          field.value
        );
    }
  }

  return result;
}

function decodeFeedEntity(bytes) {
  const state = { index: 0 };

  const entity = {
    id: '',
    tripUpdate: null
  };

  while (state.index < bytes.length) {
    const field = readField(
      bytes,
      state
    );

    if (
      field.fieldNumber === 1
      && field.wireType === 2
    ) {
      entity.id =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 2
      && field.wireType === 0
    ) {
      entity.isDeleted =
        Boolean(field.value);
    } else if (
      field.fieldNumber === 3
      && field.wireType === 2
    ) {
      entity.tripUpdate =
        decodeTripUpdate(
          field.value
        );
    }
  }

  return entity;
}

function getFirstDefined(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null) {
      return object[key];
    }
  }
  return undefined;
}

function parseSafeInteger(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`GTFS-RT JSON has an invalid ${fieldName}.`);
  }
  return number;
}

function parseRealtimeEnum(value, enumValues, defaultValue, fieldName) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'number' || /^-?\d+$/.test(String(value).trim())) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
  }

  const name = String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (Object.prototype.hasOwnProperty.call(enumValues, name)) {
    return enumValues[name];
  }

  throw new Error(`GTFS-RT JSON has an unknown ${fieldName}: ${String(value)}.`);
}

function normalizeJsonStopTimeEvent(event) {
  if (!event || typeof event !== 'object') return null;

  return {
    delay: parseSafeInteger(event.delay, 'StopTimeEvent.delay'),
    time: parseSafeInteger(event.time, 'StopTimeEvent.time'),
    scheduledTime: parseSafeInteger(
      getFirstDefined(event, ['scheduledTime', 'scheduled_time']),
      'StopTimeEvent.scheduled_time'
    ),
    uncertainty: parseSafeInteger(event.uncertainty, 'StopTimeEvent.uncertainty')
  };
}

function normalizeJsonTripDescriptor(trip) {
  if (!trip || typeof trip !== 'object') return null;

  return {
    tripId: String(getFirstDefined(trip, ['tripId', 'trip_id']) ?? '').trim(),
    routeId: String(getFirstDefined(trip, ['routeId', 'route_id']) ?? '').trim(),
    directionId: String(getFirstDefined(trip, ['directionId', 'direction_id']) ?? '').trim(),
    startTime: String(getFirstDefined(trip, ['startTime', 'start_time']) ?? '').trim(),
    startDate: String(getFirstDefined(trip, ['startDate', 'start_date']) ?? '').trim(),
    scheduleRelationship: parseRealtimeEnum(
      getFirstDefined(trip, ['scheduleRelationship', 'schedule_relationship']),
      TRIP_RELATIONSHIP,
      TRIP_RELATIONSHIP.SCHEDULED,
      'TripDescriptor.schedule_relationship'
    )
  };
}

function normalizeJsonTripProperties(properties) {
  if (!properties || typeof properties !== 'object') return null;

  return {
    tripId: String(getFirstDefined(properties, ['tripId', 'trip_id']) ?? '').trim(),
    startDate: String(getFirstDefined(properties, ['startDate', 'start_date']) ?? '').trim(),
    startTime: String(getFirstDefined(properties, ['startTime', 'start_time']) ?? '').trim()
  };
}

function normalizeJsonStopTimeUpdate(update) {
  return {
    stopSequence: parseSafeInteger(
      getFirstDefined(update, ['stopSequence', 'stop_sequence']),
      'StopTimeUpdate.stop_sequence'
    ),
    stopId: String(getFirstDefined(update, ['stopId', 'stop_id']) ?? '').trim(),
    arrival: normalizeJsonStopTimeEvent(update?.arrival),
    departure: normalizeJsonStopTimeEvent(update?.departure),
    scheduleRelationship: parseRealtimeEnum(
      getFirstDefined(update, ['scheduleRelationship', 'schedule_relationship']),
      STOP_RELATIONSHIP,
      STOP_RELATIONSHIP.SCHEDULED,
      'StopTimeUpdate.schedule_relationship'
    )
  };
}

function decodeGtfsRealtimeJsonFeed(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, '').trim());
  } catch {
    throw new Error('Trinmo TripUpdates response is not valid JSON.');
  }

  // Accept the standard GTFS-Realtime ProtoJSON envelope, including common
  // snake_case aliases and a simple { data: FeedMessage } wrapper.
  let feed = parsed;
  if (feed?.data && !feed?.header && !feed?.feedHeader) {
    feed = feed.data;
  }
  if (feed?.feedMessage && !feed?.header && !feed?.feedHeader) {
    feed = feed.feedMessage;
  }

  const header = getFirstDefined(feed, ['header', 'feedHeader', 'feed_header']);
  const entities = getFirstDefined(feed, ['entity', 'entities', 'feedEntity', 'feed_entity']);
  if (!header || !Array.isArray(entities)) {
    throw new Error('Trinmo TripUpdates JSON does not contain a GTFS-Realtime header and entity array.');
  }

  const incrementalityRaw = getFirstDefined(header, ['incrementality']);
  const feedIncrementality = incrementalityRaw === 'DIFFERENTIAL'
    ? 1
    : incrementalityRaw === 'FULL_DATASET'
      ? 0
      : parseSafeInteger(incrementalityRaw, 'FeedHeader.incrementality') ?? 0;

  if (feedIncrementality !== 0) {
    throw new Error('GTFS-RT differential feeds are not supported by this stateless API.');
  }

  const feedTimestamp = parseSafeInteger(header.timestamp, 'FeedHeader.timestamp');
  const updates = [];

  for (const entity of entities) {
    if (entity?.isDeleted === true || entity?.is_deleted === true) continue;

    const rawUpdate = getFirstDefined(entity, ['tripUpdate', 'trip_update']);
    if (!rawUpdate || typeof rawUpdate !== 'object') continue;

    const rawTrip = getFirstDefined(rawUpdate, ['trip', 'tripDescriptor', 'trip_descriptor'])
      || (getFirstDefined(rawUpdate, ['tripId', 'trip_id']) !== undefined ? rawUpdate : null);
    const rawStopUpdates = getFirstDefined(rawUpdate, [
      'stopTimeUpdate', 'stop_time_update', 'stopTimeUpdates', 'stop_time_updates'
    ]) || [];

    if (!Array.isArray(rawStopUpdates)) {
      throw new Error('GTFS-RT JSON has an invalid TripUpdate.stop_time_update array.');
    }

    const normalizedUpdate = {
      trip: normalizeJsonTripDescriptor(rawTrip),
      stopTimeUpdates: rawStopUpdates.map(normalizeJsonStopTimeUpdate),
      timestamp: parseSafeInteger(rawUpdate.timestamp, 'TripUpdate.timestamp'),
      delay: parseSafeInteger(rawUpdate.delay, 'TripUpdate.delay'),
      tripProperties: normalizeJsonTripProperties(
        getFirstDefined(rawUpdate, ['tripProperties', 'trip_properties'])
      )
    };

    if (normalizedUpdate.trip || normalizedUpdate.tripProperties) {
      updates.push(normalizedUpdate);
    }
  }

  return { updates, feedTimestamp };
}

function decodeGtfsRealtimeFeed(buffer) {
  const bytes = new Uint8Array(buffer);
  let firstContentByte = 0;
  while (
    firstContentByte < bytes.length
    && (bytes[firstContentByte] === 0x20
      || bytes[firstContentByte] === 0x09
      || bytes[firstContentByte] === 0x0a
      || bytes[firstContentByte] === 0x0d)
  ) {
    firstContentByte += 1;
  }

  // Accept JSON-encoded GTFS-Realtime when provided, while retaining the
  // protobuf path for the original binary GTFS-Realtime representation.
  if (bytes[firstContentByte] === 0x7b || bytes[firstContentByte] === 0x5b) {
    return decodeGtfsRealtimeJsonFeed(bytes);
  }

  const state = { index: 0 };

  const updates = [];

  let feedTimestamp = null;
  // This API consumes a complete snapshot and does not keep a stateful
  // differential-feed accumulator. Fail closed rather than treating a
  // partial DIFFERENTIAL feed as the full set of active trips.
  let feedIncrementality = 0;

  while (state.index < bytes.length) {
    const field = readField(
      bytes,
      state
    );

    if (
      field.fieldNumber === 1
      && field.wireType === 2
    ) {
      const headerState = {
        index: 0
      };

      while (
        headerState.index
        < field.value.length
      ) {
        const headerField =
          readField(
            field.value,
            headerState
          );

        if (
          headerField.fieldNumber === 2
          && headerField.wireType === 0
        ) {
          feedIncrementality = Number(headerField.value);
        } else if (
          headerField.fieldNumber === 3
          && headerField.wireType === 0
        ) {
          const raw =
            headerField.value;

          if (
            raw <= BigInt(
              Number.MAX_SAFE_INTEGER
            )
          ) {
            feedTimestamp =
              Number(raw);
          }
        }
      }
    } else if (
      field.fieldNumber === 2
      && field.wireType === 2
    ) {
      const entity =
        decodeFeedEntity(
          field.value
        );

      // A deleted FeedEntity is a removal instruction, not an active
      // TripUpdate. Do not let its descriptor suppress a scheduled fallback.
      if (
        !entity.isDeleted
        && (
          entity.tripUpdate?.trip
          || entity.tripUpdate?.tripProperties
        )
      ) {
        updates.push(
          entity.tripUpdate
        );
      }
    }
  }

  if (feedIncrementality !== 0) {
    throw new Error(
      'GTFS-RT differential feeds are not supported by this stateless API.'
    );
  }

  return {
    updates,
    feedTimestamp
  };
}

function normalizeStopKey(value) {
  const raw =
    String(value ?? "").trim();

  if (!raw) {
    return "";
  }

  const withoutMetroPrefix =
    raw.replace(/^M/i, "");

  const digits =
    withoutMetroPrefix.replace(
      /\D/g,
      ""
    );

  if (digits) {
    return String(
      Number(digits)
    );
  }

  return withoutMetroPrefix
    .toLowerCase();
}

function stopIdsMatch(
  left,
  right
) {
  return (
    normalizeStopKey(left)
    === normalizeStopKey(right)
  );
}

function eventTimestamp(
  update
) {
  if (
    Number.isFinite(
      update?.arrival?.time
    )
  ) {
    return update.arrival.time;
  }

  if (
    Number.isFinite(
      update?.departure?.time
    )
  ) {
    return update.departure.time;
  }

  return null;
}

function eventDelay(update) {
  if (
    Number.isFinite(
      update?.arrival?.delay
    )
  ) {
    return update.arrival.delay;
  }

  if (
    Number.isFinite(
      update?.departure?.delay
    )
  ) {
    return update.departure.delay;
  }

  return null;
}

function eventScheduledTime(update) {
  if (Number.isSafeInteger(update?.arrival?.scheduledTime)) {
    return update.arrival.scheduledTime;
  }
  if (Number.isSafeInteger(update?.departure?.scheduledTime)) {
    return update.departure.scheduledTime;
  }
  return null;
}

function eventUncertainty(update) {
  if (Number.isSafeInteger(update?.arrival?.uncertainty)) {
    return update.arrival.uncertainty;
  }
  if (Number.isSafeInteger(update?.departure?.uncertainty)) {
    return update.departure.uncertainty;
  }
  return null;
}

function getTripId(tripUpdate) {
  return String(
    tripUpdate?.trip?.tripId
    || tripUpdate?.tripProperties?.tripId
    || ''
  ).trim();
}

function getTripRouteId(tripUpdate) {
  const explicitRouteId = String(tripUpdate?.trip?.routeId || '').trim();
  if (explicitRouteId) return explicitRouteId;
  return ROUTE_ID_BY_TRIP_ID.get(getTripId(tripUpdate)) || '';
}

function getTripStartDate(tripUpdate) {
  return String(
    tripUpdate?.trip?.startDate
    || tripUpdate?.tripProperties?.startDate
    || ''
  ).trim();
}

function getTripStartTime(tripUpdate) {
  return String(
    tripUpdate?.trip?.startTime
    || tripUpdate?.tripProperties?.startTime
    || ''
  ).trim();
}

function getTripDirectionId(tripUpdate) {
  return String(tripUpdate?.trip?.directionId ?? '').trim();
}

function getTripRelationship(
  trip
) {
  return Number.isFinite(
    Number(
      trip?.scheduleRelationship
    )
  )
    ? Number(
        trip.scheduleRelationship
      )
    : TRIP_RELATIONSHIP.SCHEDULED;
}

function getStopRelationship(
  stopUpdate
) {
  return Number.isFinite(
    Number(
      stopUpdate?.scheduleRelationship
    )
  )
    ? Number(
        stopUpdate.scheduleRelationship
      )
    : STOP_RELATIONSHIP.SCHEDULED;
}

function normalizeStopTimeEvent(event) {
  if (!event) return null;
  return {
    timestamp: Number.isFinite(event.time) ? event.time : null,
    delay: Number.isFinite(event.delay) ? event.delay : null,
    scheduled_time: Number.isSafeInteger(event.scheduledTime) ? event.scheduledTime : null,
    uncertainty: Number.isSafeInteger(event.uncertainty) ? event.uncertainty : null
  };
}

function normalizeStopTimeUpdate(stopUpdate) {
  const sequence = stopUpdate?.stopSequence;
  return {
    stop_id: String(stopUpdate?.stopId || '').trim(),
    stop_sequence: Number.isSafeInteger(sequence) ? sequence : null,
    schedule_relationship: getStopRelationship(stopUpdate),
    arrival: normalizeStopTimeEvent(stopUpdate?.arrival),
    departure: normalizeStopTimeEvent(stopUpdate?.departure)
  };
}

function getTripKey(tripUpdate) {
  return [
    getTripId(tripUpdate),
    getTripStartDate(tripUpdate),
    getTripStartTime(tripUpdate),
    getTripRouteId(tripUpdate),
    getTripDirectionId(tripUpdate)
  ].join('|');
}

function buildBoard(
  updates,
  stopCode,
  feedTimestamp
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  const target =
    normalizeStopKey(
      stopCode
    );

  const grouped =
    new Map();

  const skippedTrips =
    new Map();

  // Keep every current TripUpdate descriptor and its timing updates, even
  // when it has no StopTimeUpdate for the selected stop. The service uses
  // course-level realtime timing to suppress only that exact course's GTFS
  // fallback; a bare descriptor without timing data does not suppress it.
  const realtimeTrips = new Map();

  for (
    const tripUpdate
    of updates
  ) {
    const trip = tripUpdate?.trip;
    const tripId = getTripId(tripUpdate);
    const routeId = getTripRouteId(tripUpdate);
    const startDate = getTripStartDate(tripUpdate);
    const startTime = getTripStartTime(tripUpdate);
    const directionId = getTripDirectionId(tripUpdate);
    const tripRelationship = getTripRelationship(trip);

    if (!trip && !tripId && !routeId && !startTime) {
      continue;
    }

    const descriptorKey = [tripId, startDate, startTime, routeId, directionId].join('|');
    const normalizedStopUpdates = (tripUpdate.stopTimeUpdates || []).map(normalizeStopTimeUpdate);
    if (!realtimeTrips.has(descriptorKey)) {
      realtimeTrips.set(descriptorKey, {
        trip_id: tripId,
        trip_start_date: startDate,
        trip_start_time: startTime,
        route_id: routeId,
        direction_id: directionId,
        schedule_relationship: tripRelationship,
        schedule_relationship_name: TRIP_RELATIONSHIP_NAME[tripRelationship]
          || `UNKNOWN_${tripRelationship}`,
        trip_update_timestamp: Number.isSafeInteger(tripUpdate.timestamp) ? tripUpdate.timestamp : null,
        trip_delay: Number.isSafeInteger(tripUpdate.delay) ? tripUpdate.delay : null,
        stop_time_updates: normalizedStopUpdates
      });
    } else {
      const existingDescriptor = realtimeTrips.get(descriptorKey);
      existingDescriptor.stop_time_updates.push(...normalizedStopUpdates);
      if (Number.isSafeInteger(tripUpdate.timestamp)
        && (!Number.isSafeInteger(existingDescriptor.trip_update_timestamp)
          || tripUpdate.timestamp >= existingDescriptor.trip_update_timestamp)) {
        existingDescriptor.trip_update_timestamp = tripUpdate.timestamp;
        if (Number.isSafeInteger(tripUpdate.delay)) existingDescriptor.trip_delay = tripUpdate.delay;
      }
    }

    if (
      tripRelationship
        === TRIP_RELATIONSHIP.CANCELED
      || tripRelationship
        === TRIP_RELATIONSHIP.DELETED
    ) {
      continue;
    }

    for (
      const stopUpdate
      of tripUpdate
        .stopTimeUpdates
        || []
    ) {
      const stopRelationship =
        getStopRelationship(
          stopUpdate
        );

      if (
        stopRelationship
          === STOP_RELATIONSHIP.SKIPPED
      ) {
        if (
          stopUpdate?.stopId
          && !stopIdsMatch(
            stopUpdate.stopId,
            target
          )
        ) {
          continue;
        }

        const skippedKey = [
          tripId,
          startDate,
          startTime,
          routeId,
          directionId,
          stopUpdate.stopId
            ? normalizeStopKey(
                stopUpdate.stopId
              )
            : `seq:${
                Number.isFinite(
                  Number(
                    stopUpdate.stopSequence
                  )
                )
                  ? Number(
                      stopUpdate
                        .stopSequence
                    )
                  : ""
              }`
        ].join("|");

        if (
          !skippedTrips.has(
            skippedKey
          )
        ) {
          skippedTrips.set(
            skippedKey,
            {
              trip_id: tripId,
              start_date: startDate,
              start_time: startTime,
              route_id: routeId,
              direction_id: directionId,
              stop_id:
                stopUpdate.stopId
                || "",
              stop_sequence:
                Number.isFinite(
                  Number(
                    stopUpdate
                      .stopSequence
                  )
                )
                  ? Number(
                      stopUpdate
                        .stopSequence
                    )
                  : null,
              stop_schedule_relationship:
                stopRelationship,
              stop_schedule_relationship_name:
                STOP_RELATIONSHIP_NAME[
                  stopRelationship
                ]
                  || `UNKNOWN_${stopRelationship}`
            }
          );
        }

        continue;
      }

      if (
        !stopUpdate?.stopId
        || !stopIdsMatch(
          stopUpdate.stopId,
          target
        )
      ) {
        continue;
      }

      if (
        stopRelationship
          === STOP_RELATIONSHIP.NO_DATA
      ) {
        continue;
      }

      let timestamp = eventTimestamp(stopUpdate);
      const delay = eventDelay(stopUpdate);
      const scheduledTime = eventScheduledTime(stopUpdate);

      // Some producers send scheduled_time + delay but omit absolute time.
      // That pair is a usable prediction. scheduled_time by itself is only a
      // timetable value, not evidence of realtime coverage at this stop.
      if (timestamp === null && scheduledTime !== null && delay !== null) {
        timestamp = scheduledTime + delay;
      }

      if (timestamp === null && delay === null) continue;
      if (timestamp !== null && timestamp < now - REALTIME_PAST_GRACE_SECONDS) continue;
      if (timestamp !== null && timestamp > now + LOOK_AHEAD_SECONDS) continue;

      const key =
        getTripKey(
          tripUpdate
        );

      if (!grouped.has(key)) {
        const terminalUpdate =
          (
            tripUpdate
              .stopTimeUpdates
            || []
          )
            .filter(item => {
              if (!item?.stopId) {
                return false;
              }

              const relationship =
                getStopRelationship(
                  item
                );

              return (
                relationship
                  !== STOP_RELATIONSHIP.SKIPPED
                && relationship
                  !== STOP_RELATIONSHIP.NO_DATA
              );
            })
            .sort(
              (a, b) => {
                const sa =
                  Number.isFinite(
                    Number(
                      a?.stopSequence
                    )
                  )
                    ? Number(
                        a.stopSequence
                      )
                    : -1;

                const sb =
                  Number.isFinite(
                    Number(
                      b?.stopSequence
                    )
                  )
                    ? Number(
                        b.stopSequence
                      )
                    : -1;

                return sb - sa;
              }
            )[0] || null;

        grouped.set(
          key,
          {
            trip_id: tripId,
            trip_start_date: startDate,
            trip_start_time: startTime,
            route_id: routeId,
            direction_id: directionId,
            schedule_relationship:
              tripRelationship,
            schedule_relationship_name:
              TRIP_RELATIONSHIP_NAME[
                tripRelationship
              ]
                || `UNKNOWN_${tripRelationship}`,
            destination_stop_id:
              terminalUpdate
                ?.stopId
              || "",
            times: []
          }
        );
      }

      grouped
        .get(key)
        .times
        .push({
          timestamp,
          delay,
          stop_schedule_relationship:
            stopRelationship,
          stop_schedule_relationship_name:
            STOP_RELATIONSHIP_NAME[
              stopRelationship
            ]
              || `UNKNOWN_${stopRelationship}`,
          scheduled_time: scheduledTime,
          uncertainty: eventUncertainty(stopUpdate)
        });
    }
  }

  const routes =
    [...grouped.values()]
      .map(row => ({
        ...row,
        times:
          row.times
          .sort(
              (a, b) => {
                const aTimestamp = Number.isFinite(a.timestamp) ? a.timestamp : Number.POSITIVE_INFINITY;
                const bTimestamp = Number.isFinite(b.timestamp) ? b.timestamp : Number.POSITIVE_INFINITY;
                return aTimestamp - bTimestamp;
              }
            )
            .slice(
              0,
              MAX_RESULTS_PER_ROUTE
            )
      }))
      .filter(
        row =>
        row.times.length
      )
      .sort(
        (a, b) =>
          a.times[0].timestamp
          - b.times[0].timestamp
      );

  return {
    status:
      routes.length
        ? "ok"
        : "empty",

    stop_code:
      String(stopCode),

    generated_at:
      feedTimestamp,

    skipped_trips:
      [...skippedTrips.values()],

    realtime_trips:
      [...realtimeTrips.values()],

    routes
  };
}

async function fetchRealtimeFeed() {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      FEED_TIMEOUT_MS
    );

  try {
    const upstream =
      await fetch(
        FEED_URL,
        {
          signal:
            controller.signal,
          headers: {
            Accept:
              'application/json, application/x-protobuf, application/octet-stream',
            'User-Agent':
              'GTSofia virtual boards'
          },
          cache: 'no-store'
        }
      );

    if (!upstream.ok) {
      throw new Error(
        `Trinmo GTFS-RT returned ${upstream.status}.`
      );
    }

    const body =
      await upstream.arrayBuffer();

    if (
      !body.byteLength
    ) {
      throw new Error(
        'Trinmo GTFS-RT feed is empty.'
      );
    }

    const feed = decodeGtfsRealtimeFeed(body);
    const feedTimestamp = Number(feed.feedTimestamp);
    if (!Number.isSafeInteger(feedTimestamp) || feedTimestamp <= 0) {
      throw new Error('GTFS-RT feed has no valid timestamp; realtime freshness is unknown.');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const ageSeconds = nowSeconds - feedTimestamp;
    if (ageSeconds > MAX_FEED_AGE_SECONDS) {
      throw new Error(`GTFS-RT feed is stale (${ageSeconds}s old).`);
    }
    if (ageSeconds < -MAX_FEED_FUTURE_SKEW_SECONDS) {
      throw new Error('GTFS-RT feed timestamp is too far in the future.');
    }

    return feed;
  } finally {
    clearTimeout(
      timeout
    );
  }
}

async function getRealtimeFeed() {
  // Do not retain a feed snapshot between refreshes. Coalesce only requests
  // that are genuinely concurrent, then discard the Promise so the next
  // scheduled or manual refresh fetches a fresh upstream snapshot.
  if (feedFetchPromise) return feedFetchPromise;

  feedFetchPromise = fetchRealtimeFeed().finally(() => {
    feedFetchPromise = null;
  });

  return feedFetchPromise;
}

function isMetroStop(stopCode) {
  const raw = String(stopCode ?? '').trim();
  const stop = stopsData.find(item =>
    String(item?.stop_id ?? '').trim() === raw
    || String(item?.stop_code ?? '').trim() === raw
  );
  return /^M/i.test(String(stop?.stop_id || raw))
    || /^M/i.test(String(stop?.stop_code || ''));
}

function setBoardResponseHeaders(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
}

module.exports =
  async function handler(
    req,
    res
  ) {
    if (
      req.method !== "GET"
    ) {
      res.setHeader(
        "Allow",
        "GET"
      );

      return res
        .status(405)
        .json({
          error:
            "Method not allowed."
        });
    }

    const stopCode =
      String(
        req.query?.stop_code
        || ""
      ).trim();

    if (!stopCode) {
      return res
        .status(400)
        .json({
          error:
            "Missing stop_code."
        });
    }

    const now = new Date();
    const metro = isMetroStop(stopCode);
    let realtimeBoard = {
      status: 'empty',
      stop_code: stopCode,
      generated_at: null,
      skipped_trips: [],
      realtime_trips: [],
      routes: []
    };
    let realtimeStatus = metro ? 'not_applicable' : 'available';
    let realtimeMessage = '';
    let realtimeFeedTimestamp = null;

    if (!metro) {
      try {
        const feed = await getRealtimeFeed();
        realtimeFeedTimestamp = feed.feedTimestamp;
        realtimeBoard = buildBoard(
          feed.updates,
          stopCode,
          feed.feedTimestamp
        );
      } catch (error) {
        realtimeStatus = 'unavailable';
        realtimeMessage = 'Realtime информацията временно не е налична — показваме разписанието.';
        const detail = error?.name === 'AbortError'
          ? 'Trinmo GTFS-RT request timed out.'
          : (error?.message || 'Unable to fetch/decode Trinmo GTFS-RT.');
        console.warn(`GTSofia realtime fallback for stop ${stopCode}: ${detail}`);
      }
    }

    try {
      const board = buildVirtualBoard(realtimeBoard, stopCode, now);
      setBoardResponseHeaders(res);
      return res.status(200).json({
        ...board,
        realtime_status: realtimeStatus,
        realtime_message: realtimeMessage,
        realtime_feed_timestamp: realtimeFeedTimestamp,
        refreshed_at: Math.floor(Date.now() / 1000)
      });
    } catch (error) {
      const message = error?.message || 'Unable to build the virtual board.';
      setBoardResponseHeaders(res);
      return res.status(500).json({ error: message });
    }
  };
