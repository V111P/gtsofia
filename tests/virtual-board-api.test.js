const assert = require('node:assert/strict');
const handler = require('../api/virtual-board.js');
const { buildVirtualBoard } = require('../api/virtual-board-service');

function varint(value) {
  let n = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function field(number, wireType, value) {
  const tag = varint((number << 3) | wireType);
  if (wireType === 0) return Buffer.concat([tag, value]);
  if (wireType === 2) return Buffer.concat([tag, varint(value.length), value]);
  throw new Error(`Unsupported wire type ${wireType}`);
}

const text = value => Buffer.from(String(value), 'utf8');

function encodeTripDescriptor({ tripId, startTime, startDate = null, routeId }) {
  return Buffer.concat([
    field(1, 2, text(tripId)),
    field(2, 2, text(startTime)),
    // TripDescriptor.start_date is the service date of this trip. Tests that
    // use today's active GTFS schedule must use today's Sofia service date.
    field(3, 2, text(startDate || sofiaDate)),
    field(5, 2, text(routeId))
  ]);
}

function encodeStopTimeUpdate({ stopId = null, stopSequence = null, relationship, timestamp = null, scheduledTime = null, delay = null, uncertainty = null }) {
  const fields = [];
  if (stopSequence != null) fields.push(field(1, 0, varint(stopSequence)));
  if (stopId != null) fields.push(field(4, 2, text(stopId)));
  fields.push(field(5, 0, varint(relationship)));

  if (timestamp != null || scheduledTime != null || delay != null) {
    const eventFields = [];
    if (delay != null) eventFields.push(field(1, 0, varint(delay)));
    if (timestamp != null) eventFields.push(field(2, 0, varint(timestamp)));
    // GTFS-Realtime StopTimeEvent uses field 3 for uncertainty and field 4
    // for scheduled_time.
    if (uncertainty != null) eventFields.push(field(3, 0, varint(uncertainty)));
    if (scheduledTime != null) eventFields.push(field(4, 0, varint(scheduledTime)));
    fields.push(field(2, 2, Buffer.concat(eventFields)));
  }

  return Buffer.concat(fields);
}

function encodeFeedHeader(timestamp) {
  return Buffer.concat([
    field(1, 2, text('2.0')),
    field(3, 0, varint(timestamp))
  ]);
}

function encodeTripProperties({ tripId, startDate, startTime }) {
  return Buffer.concat([
    field(1, 2, text(tripId)),
    field(2, 2, text(startDate)),
    field(3, 2, text(startTime))
  ]);
}

function encodeTripUpdate({ trip = null, tripProperties = null, stopUpdates = [], timestamp = null, delay = null }) {
  return Buffer.concat([
    ...(trip ? [field(1, 2, encodeTripDescriptor(trip))] : []),
    ...stopUpdates.map(stopUpdate => field(2, 2, encodeStopTimeUpdate(stopUpdate))),
    ...(timestamp != null ? [field(4, 0, varint(timestamp))] : []),
    ...(delay != null ? [field(5, 0, varint(delay))] : []),
    ...(tripProperties ? [field(6, 2, encodeTripProperties(tripProperties))] : [])
  ]);
}

function encodeEntity(id, tripUpdate, isDeleted = false) {
  return Buffer.concat([
    field(1, 2, text(id)),
    ...(isDeleted ? [field(2, 0, varint(1))] : []),
    field(3, 2, tripUpdate)
  ]);
}

const now = Math.floor(Date.now() / 1000);
const nowDate = new Date(now * 1000);
const sofiaDateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit'
}).formatToParts(nowDate);
const sofiaDate = `${sofiaDateParts.find(part => part.type === 'year').value}${sofiaDateParts.find(part => part.type === 'month').value}${sofiaDateParts.find(part => part.type === 'day').value}`;

// Choose real scheduled courses from the checked-in GTFS so this test verifies
// that the binary protobuf parser preserves TripUpdates even without a stop
// prediction, and ignores FeedEntity.is_deleted=true.
const staticAtStop0605 = buildVirtualBoard({ routes: [], skipped_trips: [] }, '0605', nowDate);
const deletedFallbackCourse = staticAtStop0605.routes.find(route =>
  route.route_id === 'TB2' && route.original_trip_id && route.trip_start_time
  && route.times?.some(time => time.scheduled)
);
assert.ok(deletedFallbackCourse, 'GTFS must contain an upcoming TB2 fallback course at 0605');
const deletedFallbackTime = deletedFallbackCourse.times.find(time => time.scheduled).timestamp;
const normalFallbackCourse = staticAtStop0605.routes
  .filter(route => route.route_id === 'TB2')
  .flatMap(route => (route.times || [])
    .filter(time => time.scheduled)
    .map(time => ({ ...route, ...time, original_trip_id: time.trip_id || route.original_trip_id })))
  .find(time => time.trip_id && time.trip_id !== deletedFallbackCourse.original_trip_id);
assert.ok(normalFallbackCourse, 'GTFS must contain a second active TB2 course for the realtime ID-normalization test');

const staticAtStop2082 = buildVirtualBoard({ routes: [], skipped_trips: [] }, '2082', nowDate);
const realtimeOnlyCourse = staticAtStop2082.routes.find(route =>
  route.route_id === 'TB7' && route.original_trip_id && route.trip_start_time
  && route.times?.some(time => time.scheduled)
);
assert.ok(realtimeOnlyCourse, 'GTFS must contain an upcoming TB7 fallback course at 2082');
const realtimeOnlyTime = realtimeOnlyCourse.times.find(time => time.scheduled).timestamp;
const skippedTrip = encodeTripUpdate({
  trip: {
    tripId: 'REALTIME-SKIPPED',
    startTime: '08:10:00',
    routeId: 'TB2'
  },
  stopUpdates: [{
    stopId: '0605',
    relationship: 1
  }]
});

const sequenceSkippedTrip = encodeTripUpdate({
  trip: {
    tripId: 'REALTIME-SKIPPED-SEQUENCE',
    startTime: '08:10:00',
    routeId: 'TB2'
  },
  stopUpdates: [{
    stopSequence: 24,
    relationship: 1
  }]
});

const noDataTrip = encodeTripUpdate({
  trip: {
    tripId: 'REALTIME-NODATA',
    startTime: '08:25:00',
    routeId: 'TB2'
  },
  stopUpdates: [{
    stopId: '0605',
    relationship: 2
  }]
});

const normalTrip = encodeTripUpdate({
  trip: {
    tripId: normalFallbackCourse.original_trip_id,
    startTime: normalFallbackCourse.trip_start_time,
    routeId: 'TB2'
  },
  stopUpdates: [{
    stopId: '0605',
    relationship: 0,
    timestamp: now + 60,
    delay: -15,
    uncertainty: 30
  }]
});

const predepartureDelayTrip = encodeTripUpdate({
  trip: {
    tripId: realtimeOnlyCourse.original_trip_id,
    startTime: realtimeOnlyCourse.trip_start_time,
    startDate: sofiaDate,
    routeId: 'TB7'
  },
  timestamp: now,
  delay: 90,
  // SCHEDULED TripUpdates must contain at least one StopTimeUpdate. This
  // downstream update leaves TripUpdate.delay active at the earlier board stop.
  stopUpdates: [{ stopSequence: 22, relationship: 0, delay: 0 }]
});

// An active TripUpdate descriptor identifies its exact scheduled course, but
// without a usable prediction at or before the selected stop it must not hide
// that stop's GTFS time. A deleted copy is also present below and must be ignored.
const activeTripWithoutPrediction = encodeTripUpdate({
  trip: {
    tripId: deletedFallbackCourse.original_trip_id,
    startTime: deletedFallbackCourse.trip_start_time,
    startDate: sofiaDate,
    routeId: 'TB2'
  }
});

const feedEntities = Buffer.concat([
  field(2, 2, encodeEntity('skipped', skippedTrip)),
  field(2, 2, encodeEntity('skipped-sequence', sequenceSkippedTrip)),
  field(2, 2, encodeEntity('no-data', noDataTrip)),
  field(2, 2, encodeEntity('normal', normalTrip)),
  // A valid TripUpdate may expose a trip-level delay before a stop-specific
  // prediction exists. It must be propagated to a downstream board stop.
  field(2, 2, encodeEntity('predeparture-trip-level-delay', predepartureDelayTrip)),
  // A live trip descriptor without a prediction at this stop must not
  // suppress the timetable; the per-stop GTFS fallback remains available.
  field(2, 2, encodeEntity('realtime-without-stop-prediction', encodeTripUpdate({
    tripProperties: {
      tripId: realtimeOnlyCourse.original_trip_id,
      startTime: realtimeOnlyCourse.trip_start_time,
      startDate: sofiaDate
    }
  }))),
  field(2, 2, encodeEntity('active-trip-without-prediction', activeTripWithoutPrediction)),
  // A deleted entity is not an active realtime trip and must not suppress fallback.
  field(2, 2, encodeEntity('deleted-trip', encodeTripUpdate({
    trip: {
      tripId: deletedFallbackCourse.original_trip_id,
      startTime: deletedFallbackCourse.trip_start_time,
      startDate: sofiaDate,
      routeId: 'TB2'
    }
  }), true))
]);

function makeFeed(timestamp = Math.floor(Date.now() / 1000), includeTimestamp = true) {
  const header = includeTimestamp
    ? encodeFeedHeader(timestamp)
    : field(1, 2, text('2.0'));
  return Buffer.concat([
    field(1, 2, header),
    feedEntities
  ]);
}

const feed = makeFeed();

let realtimeFetchCount = 0;
global.fetch = async () => {
  realtimeFetchCount += 1;
  return {
    ok: true,
    arrayBuffer: async () => feed.buffer.slice(feed.byteOffset, feed.byteOffset + feed.byteLength)
  };
};

const req = {
  method: 'GET',
  query: { stop_code: '0605' }
};

let payload = null;
const res = {
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(value) {
    payload = value;
    return this;
  },
  setHeader() {}
};

(async () => {
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(payload.status === 'ok' || payload.status === 'empty', true);
  assert.ok(Array.isArray(payload.routes), 'the API must return the final board rows');
  assert.equal(typeof payload.generated_at, 'number');
  assert.equal(payload.realtime_status, 'available');
  assert.equal(realtimeFetchCount, 1, 'the first manual board load should fetch the realtime feed');
  assert.equal(Object.hasOwn(payload, 'active_trips'), false);
  assert.equal(Object.hasOwn(payload, 'skipped_trips'), false);

  const realtimeArrival = payload.routes.find(route =>
    route.trip_id === normalFallbackCourse.original_trip_id
      && route.times?.some(time => Number(time.timestamp) === now + 60)
  );
  assert.ok(realtimeArrival, 'a stop-specific realtime prediction must be included in the final board response');
  assert.equal(realtimeArrival.realtime, true);
  assert.equal(
    realtimeArrival.trip_id,
    normalFallbackCourse.original_trip_id,
    'a SCHEDULED TripUpdate must retain its exact canonical GTFS Trip ID'
  );
  assert.ok(
    realtimeArrival.times.some(time => time.trip_id === realtimeArrival.trip_id
      && !time.realtime_trip_id),
    'the arrival event must use the exact canonical GTFS trip identity'
  );
  assert.ok(
    !payload.routes.flatMap(route => route.times || []).some(time => time.scheduled
      && time.trip_id === realtimeArrival.trip_id),
    'the canonical GTFS course must not also be returned as a scheduled fallback beside its realtime prediction'
  );
  assert.ok(realtimeArrival.meta, 'the API should return line display metadata');
  assert.ok(realtimeArrival.destination, 'the API should resolve a destination before returning the board');
  assert.ok(
    realtimeArrival.times.some(time => time.timestamp === now + 60
      && time.uncertainty === 30
      && Number.isFinite(time.delay)),
    'the protobuf decoder must preserve absolute time and uncertainty, and the service must derive delay from the static GTFS event when time is authoritative'
  );

  const deletedFallbackTimes = payload.routes
    .filter(route => route.route_id === 'TB2')
    .flatMap(route => route.times.map(time => Number(time.timestamp)));
  assert.ok(
    deletedFallbackTimes.includes(Math.round(deletedFallbackTime)),
    'an active TripUpdate without a prediction at or before the selected stop must leave its GTFS fallback visible'
  );

  req.query.stop_code = '2082';
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  const inferredPredepartureCourse = payload.routes.find(route =>
    route.trip_id === realtimeOnlyCourse.original_trip_id
      && route.times?.some(time => Math.round(Number(time.timestamp)) === Math.round(realtimeOnlyTime + 90))
  );
  assert.ok(
    inferredPredepartureCourse,
    'the protobuf parser and API should expose trip-level delay as a downstream realtime prediction before origin departure'
  );
  assert.equal(inferredPredepartureCourse.realtime, true);
  const realtimeOnlyTimes = payload.routes
    .filter(route => route.route_id === 'TB7')
    .flatMap(route => route.times.map(time => Number(time.timestamp)));
  assert.ok(
    !realtimeOnlyTimes.includes(Math.round(realtimeOnlyTime)),
    'a valid realtime prediction inferred from TripUpdate.delay must replace the matching static fallback'
  );
  assert.ok(
    realtimeOnlyTimes.some(time => time > realtimeOnlyTime),
    'other scheduled TB7 trips must remain visible when one trip has realtime but no stop prediction'
  );
  assert.equal(realtimeFetchCount, 2, 'a subsequent manual refresh must fetch a new feed rather than use a time-based cache');

  // When the upstream realtime service fails, the API still returns a usable
  // GTFS-only board instead of an HTTP 502.
  global.fetch = async () => { throw new Error('simulated upstream outage'); };
  req.query.stop_code = '0605';
  await handler(req, res);
  assert.equal(res.statusCode, 200, 'upstream realtime failure must not fail the entire virtual-board request');
  assert.equal(payload.realtime_status, 'unavailable');
  assert.match(payload.realtime_message, /показваме разписанието/i);
  assert.ok(Array.isArray(payload.routes), 'the GTFS fallback must still return board rows');
  assert.ok(
    payload.routes.every(route => route.times.every(time => time.scheduled === true)),
    'when realtime is unavailable, all returned arrival times must be clearly marked as scheduled'
  );
  assert.ok(
    payload.routes.some(route => route.times.length > 0),
    'an upstream outage must still produce actual timetable arrivals when GTFS has upcoming service'
  );

  // A feed older than the freshness limit must be treated as unavailable;
  // fetching it now does not make its old predictions fresh.
  global.fetch = async () => {
    const staleFeed = makeFeed(Math.floor(Date.now() / 1000) - 180);
    return {
      ok: true,
      arrayBuffer: async () => staleFeed.buffer.slice(staleFeed.byteOffset, staleFeed.byteOffset + staleFeed.byteLength)
    };
  };
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.realtime_status, 'unavailable', 'stale realtime snapshots must fall back to GTFS');
  assert.ok(payload.routes.every(route => route.times.every(time => time.scheduled === true)));

  // Missing feed timestamps are unknown freshness, not permission to stamp
  // the payload with the current server time and present it as realtime.
  global.fetch = async () => {
    const untimestampedFeed = makeFeed(0, false);
    return {
      ok: true,
      arrayBuffer: async () => untimestampedFeed.buffer.slice(untimestampedFeed.byteOffset, untimestampedFeed.byteOffset + untimestampedFeed.byteLength)
    };
  };
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.realtime_status, 'unavailable', 'a feed without timestamp must use the GTFS fallback');
  assert.ok(payload.routes.every(route => route.times.every(time => time.scheduled === true)));

  // Metro is schedule-only; it must not make an upstream realtime request.
  let metroFetchCount = 0;
  global.fetch = async () => { metroFetchCount += 1; throw new Error('metro must not request realtime'); };
  req.query.stop_code = 'M1';
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.realtime_status, 'not_applicable');
  assert.equal(payload.realtime_message, '', 'metro must not return an explanatory schedule-only status label');
  assert.equal(metroFetchCount, 0, 'metro boards must use GTFS without requesting the realtime feed');

  console.log('virtual-board-api: all tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
