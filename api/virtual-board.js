const { buildVirtualBoard } = require('./virtual-board-service');
const tripsData = require('../data/trips.json');
const stopsData = require('../data/stops.json');

const FEED_URL = 'https://gtfs.sofiatraffic.bg/api/v1/trip-updates';
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

function decodeGtfsRealtimeFeed(buffer) {
  const bytes =
    new Uint8Array(buffer);

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

function selectStopTimeEvent(update, preferDeparture = false) {
  const arrival = update?.arrival || null;
  const departure = update?.departure || null;
  const hasTiming = event => event
    && (Number.isFinite(event.time) || Number.isFinite(event.delay));
  const preferred = preferDeparture ? departure : arrival;
  const secondary = preferDeparture ? arrival : departure;
  if (hasTiming(preferred)) return preferred;
  if (hasTiming(secondary)) return secondary;
  return null;
}

function selectStopTimeEventType(update, preferDeparture = false) {
  const event = selectStopTimeEvent(update, preferDeparture);
  return event && update?.arrival === event ? 'arrival' : (event ? 'departure' : null);
}

function eventTimestamp(update) {
  const event = selectStopTimeEvent(update);
  return Number.isFinite(event?.time) ? event.time : null;
}

function eventDelay(update) {
  const event = selectStopTimeEvent(update);
  return Number.isFinite(event?.delay) ? event.delay : null;
}

function eventScheduledTime(update) {
  const event = selectStopTimeEvent(update);
  return Number.isSafeInteger(event?.scheduledTime) ? event.scheduledTime : null;
}

function eventUncertainty(update) {
  const event = selectStopTimeEvent(update);
  return Number.isSafeInteger(event?.uncertainty) ? event.uncertainty : null;
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
  // when it has no StopTimeUpdate for the selected stop. The service resolves
  // the descriptor against the static trip and selected stop before deciding
  // whether a realtime prediction replaces the GTFS fallback.
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
      tripRelationship === TRIP_RELATIONSHIP.CANCELED
      || tripRelationship === TRIP_RELATIONSHIP.DELETED
      || tripRelationship === TRIP_RELATIONSHIP.DUPLICATED
    ) {
      // DUPLICATED requires TripProperties (new trip ID, service date and
      // start time) plus a shifted static schedule. Until that full mapping is
      // available, do not mislabel it as the original scheduled trip. It does
      // not cancel or replace the original GTFS trip.
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
          Number.isSafeInteger(stopUpdate?.stopSequence)
            ? `seq:${stopUpdate.stopSequence}`
            : `stop:${String(stopUpdate?.stopId || '').trim()}`
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
      const scheduledTime = [
        TRIP_RELATIONSHIP.NEW,
        TRIP_RELATIONSHIP.REPLACEMENT,
        TRIP_RELATIONSHIP.DUPLICATED
      ].includes(tripRelationship)
        ? eventScheduledTime(stopUpdate)
        : null;
      const eventType = selectStopTimeEventType(stopUpdate);

      // For scheduled trips, StopTimeEvent.time is the absolute prediction;
      // delay-only events are resolved against the matched static GTFS stop
      // time by the virtual-board service. scheduled_time is only permitted
      // for NEW, REPLACEMENT or DUPLICATED trips and is not itself a prediction.
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
            trip_update_timestamp: Number.isSafeInteger(tripUpdate.timestamp)
              ? tripUpdate.timestamp
              : null,
            destination_stop_id:
              terminalUpdate
                ?.stopId
              || "",
            times: []
          }
        );
      }

      const groupedTrip = grouped.get(key);
      if (Number.isSafeInteger(tripUpdate.timestamp)
        && (!Number.isSafeInteger(groupedTrip.trip_update_timestamp)
          || tripUpdate.timestamp >= groupedTrip.trip_update_timestamp)) {
        groupedTrip.trip_update_timestamp = tripUpdate.timestamp;
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
          event_type: eventType,
          stop_id: String(stopUpdate?.stopId || '').trim(),
          stop_sequence: Number.isSafeInteger(stopUpdate?.stopSequence) ? stopUpdate.stopSequence : null,
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
              'application/x-protobuf, application/octet-stream',
            'User-Agent':
              'GTSofia virtual boards'
          },
          cache: 'no-store'
        }
      );

    if (!upstream.ok) {
      throw new Error(
        `Sofia Traffic GTFS-RT returned ${upstream.status}.`
      );
    }

    const body =
      await upstream.arrayBuffer();

    if (
      !body.byteLength
    ) {
      throw new Error(
        'Sofia Traffic GTFS-RT feed is empty.'
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

function summarizeRealtimeDiagnostics(feed, board, nowSeconds) {
  const updates = Array.isArray(feed?.updates) ? feed.updates : [];
  const ages = updates
    .map(update => Number.isSafeInteger(update?.timestamp)
      ? nowSeconds - update.timestamp
      : null)
    .filter(age => age !== null);
  const finalArrivals = (Array.isArray(board?.routes) ? board.routes : [])
    .flatMap(route => Array.isArray(route?.times) ? route.times : []);

  return {
    feed_timestamp: Number.isFinite(feed?.feedTimestamp) ? feed.feedTimestamp : null,
    feed_timestamp_age_seconds: Number.isFinite(feed?.feedTimestamp)
      ? nowSeconds - feed.feedTimestamp
      : null,
    feed_max_age_seconds: MAX_FEED_AGE_SECONDS,
    decoded_trip_updates: updates.length,
    trip_updates_with_trip_id: updates.filter(update => Boolean(getTripId(update))).length,
    trip_updates_with_route_id: updates.filter(update => Boolean(getTripRouteId(update))).length,
    trip_updates_with_start_date: updates.filter(update => Boolean(getTripStartDate(update))).length,
    trip_updates_with_start_time: updates.filter(update => Boolean(getTripStartTime(update))).length,
    trip_updates_with_direction_id: updates.filter(update => Boolean(getTripDirectionId(update))).length,
    trip_updates_with_timestamp: ages.length,
    trip_updates_older_than_120_seconds: ages.filter(age => age > 120).length,
    oldest_trip_update_age_seconds: ages.length ? Math.max(...ages) : null,
    stop_time_updates: updates.reduce((sum, update) => sum + (update.stopTimeUpdates?.length || 0), 0),
    trip_update_samples: updates.slice(0, 5).map(update => ({
      trip_id: getTripId(update),
      route_id: getTripRouteId(update),
      direction_id: getTripDirectionId(update),
      start_date: getTripStartDate(update),
      start_time: getTripStartTime(update),
      timestamp: Number.isSafeInteger(update?.timestamp) ? update.timestamp : null,
      stop_updates: (Array.isArray(update?.stopTimeUpdates) ? update.stopTimeUpdates : [])
        .slice(0, 4)
        .map(stopUpdate => ({
          stop_id: String(stopUpdate?.stopId || ''),
          stop_sequence: Number.isSafeInteger(stopUpdate?.stopSequence) ? stopUpdate.stopSequence : null,
          schedule_relationship: getStopRelationship(stopUpdate),
          arrival_time: Number.isSafeInteger(stopUpdate?.arrival?.time) ? stopUpdate.arrival.time : null,
          arrival_delay: Number.isSafeInteger(stopUpdate?.arrival?.delay) ? stopUpdate.arrival.delay : null,
          departure_time: Number.isSafeInteger(stopUpdate?.departure?.time) ? stopUpdate.departure.time : null,
          departure_delay: Number.isSafeInteger(stopUpdate?.departure?.delay) ? stopUpdate.departure.delay : null
        }))
    })),
    output_realtime_arrivals: finalArrivals.filter(time => time?.source === 'realtime' || time?.scheduled === false).length,
    output_static_arrivals: finalArrivals.filter(time => time?.source === 'static' || time?.scheduled === true).length,
    output_realtime_routes: (Array.isArray(board?.routes) ? board.routes : [])
      .filter(route => route?.source === 'realtime' || route?.realtime === true)
      .slice(0, 5)
      .map(route => ({ route_id: route.route_id, trip_id: route.trip_id, direction_id: route.direction_id }))
  };
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
    const debugEnabled = String(req.query?.debug || '') === '1';

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
    let realtimeDiagnostics = null;
    let diagnosticFeed = null;
    let realtimeDebugError = '';

    if (!metro) {
      try {
        const feed = await getRealtimeFeed();
        diagnosticFeed = feed;
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
          ? 'Sofia Traffic GTFS-RT request timed out.'
          : (error?.message || 'Unable to fetch/decode GTFS-RT.');
        realtimeDebugError = detail;
        console.warn(`GTSofia realtime fallback for stop ${stopCode}: ${detail}`);
      }
    }

    try {
      const board = buildVirtualBoard(realtimeBoard, stopCode, now);
      if (debugEnabled && !metro && realtimeDiagnostics === null && realtimeStatus === 'available') {
        // Feed was fetched successfully but may contain zero entities after
        // decoding; diagnostics help distinguish feed/decoder problems from
        // static-trip matching and stop-update resolution failures.
        realtimeDiagnostics = summarizeRealtimeDiagnostics(
          diagnosticFeed,
          board,
          Math.floor(Date.now() / 1000)
        );
      }
      setBoardResponseHeaders(res);
      return res.status(200).json({
        ...board,
        realtime_status: realtimeStatus,
        realtime_message: realtimeMessage,
        realtime_feed_timestamp: realtimeFeedTimestamp,
        ...(debugEnabled ? { realtime_diagnostics: realtimeDiagnostics || { feed: realtimeStatus, message: realtimeMessage, error: realtimeDebugError || null } } : {}),
        refreshed_at: Math.floor(Date.now() / 1000)
      });
    } catch (error) {
      const message = error?.message || 'Unable to build the virtual board.';
      setBoardResponseHeaders(res);
      return res.status(500).json({ error: message });
    }
  };
