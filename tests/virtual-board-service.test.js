const assert = require('node:assert/strict');
const { buildVirtualBoard, createDataContext } = require('../api/virtual-board-service');

const now = new Date('2026-10-30T13:00:00+02:00');

function createFixture() {
  return {
    routes: [
      { route_id: 'TB7', route_short_name: '7', route_type: '11', route_color: '27AAE1', route_text_color: 'FFFFFF' },
      { route_id: 'M1', route_short_name: 'M1', route_type: '1', route_color: '1C75BC', route_text_color: 'FFFFFF' },
      { route_id: 'LOOP', route_short_name: 'L', route_type: '11', route_color: '27AAE1', route_text_color: 'FFFFFF' }
    ],
    directions: {
      TB7: {
        D1: {
          key: 'D1',
          direction_id: 'D1',
          headsign: 'Крайна спирка',
          destination: 'Крайна спирка',
          pattern: ['START', 'BOARD', 'END'],
          stops: [
            { stop_id: 'START', osm_name: 'Начало' },
            { stop_id: 'BOARD', osm_name: 'Табло' },
            { stop_id: 'END', osm_name: 'Крайна спирка от OSM' }
          ]
        }
      },
      M1: {
        D1: {
          key: 'D1',
          headsign: 'Метростанция Крайна',
          destination: 'Метростанция Крайна',
          pattern: ['M1', 'M2'],
          stops: [
            { stop_id: 'M1', osm_name: 'Метростанция Начална' },
            { stop_id: 'M2', osm_name: 'Метростанция Крайна' }
          ]
        }
      },
      LOOP: {
        D1: {
          key: 'D1',
          direction_id: 'D1',
          headsign: 'Loop terminal',
          destination: 'Loop terminal',
          pattern: ['LA', 'LB', 'LC', 'LB', 'LD'],
          stops: [
            { stop_id: 'LA', osm_name: 'Loop A' },
            { stop_id: 'LB', osm_name: 'Loop B' },
            { stop_id: 'LC', osm_name: 'Loop C' },
            { stop_id: 'LB', osm_name: 'Loop B' },
            { stop_id: 'LD', osm_name: 'Loop D' }
          ]
        }
      }
    },
    schedules: {
      TB7: {
        D1: {
          weekday: [
            {
              trip_id: 1,
              original_trip_id: 'GTFS-TRIP-A',
              service_id: 'SERVICE',
              start_time: '13:00:00',
              stop_sequences: [1, 2, 3],
              times: ['13:00:00', '13:40:00', '14:03:00'],
              arrival_times: ['12:59:00', '13:39:00', '14:02:00']
            },
            {
              trip_id: 2,
              original_trip_id: 'GTFS-TRIP-B',
              service_id: 'SERVICE',
              start_time: '13:10:00',
              stop_sequences: [1, 2, 3],
              times: ['13:10:00', '13:50:00', '14:13:00']
            },
            {
              trip_id: 3,
              original_trip_id: 'GTFS-TRIP-C',
              service_id: 'SERVICE',
              start_time: '13:20:00',
              stop_sequences: [1, 2, 3],
              times: ['13:20:00', '14:00:00', '14:23:00']
            },
            {
              trip_id: 4,
              original_trip_id: 'GTFS-TRIP-D',
              service_id: 'SERVICE',
              start_time: '13:30:00',
              stop_sequences: [1, 2, 3],
              times: ['13:30:00', '14:10:00', '14:33:00']
            },
            {
              trip_id: 6,
              original_trip_id: 'GTFS-PARTIAL-TRIP',
              service_id: 'SERVICE',
              start_time: '13:05:00',
              stop_sequences: [1, 2, 3],
              times: ['13:05:00', '13:30:00', null]
            },
            {
              trip_id: 7,
              original_trip_id: 'GTFS-TRIP-AT-LIMIT',
              service_id: 'SERVICE',
              start_time: '16:48:00',
              stop_sequences: [1, 2, 3],
              times: ['16:48:00', '16:58:00', '17:18:00']
            },
            {
              trip_id: 8,
              original_trip_id: 'GTFS-TRIP-AFTER-LIMIT',
              service_id: 'SERVICE',
              start_time: '16:49:00',
              stop_sequences: [1, 2, 3],
              times: ['16:49:00', '16:59:00', '17:19:00']
            }
          ],
          weekend: []
        }
      },
      M1: {
        D1: {
          weekday: [{
            trip_id: 5,
            original_trip_id: 'METRO-TRIP-A',
            service_id: 'SERVICE',
            start_time: '13:00:00',
            stop_sequences: [1, 2],
            times: ['13:00:00', '13:20:00']
          }],
          weekend: []
        }
      },
      LOOP: {
        D1: {
          weekday: [{
            trip_id: 9,
            original_trip_id: 'LOOP-TRIP-A',
            service_id: 'SERVICE',
            start_time: '13:00:00',
            stop_sequences: [10, 20, 30, 40, 50],
            times: ['13:00:00', '13:10:00', '13:20:00', '13:40:00', '14:00:00']
          }],
          weekend: []
        }
      }
    },
    stops: [
      { stop_id: 'BOARD', stop_code: '0200', stop_name: 'Табло', osm_stop_name: 'Табло', stop_name_source: 'osm' },
      { stop_id: 'END', stop_code: '0300', stop_name: 'Крайна спирка GTFS', osm_stop_name: 'Крайна спирка от OSM', stop_name_source: 'osm' },
      { stop_id: 'M1', stop_code: '1', stop_name: 'Метростанция Начална', osm_stop_name: 'Метростанция Начална', stop_name_source: 'osm' },
      { stop_id: 'M2', stop_code: '2', stop_name: 'Метростанция Крайна', osm_stop_name: 'Метростанция Крайна', stop_name_source: 'osm' },
      { stop_id: 'LA', stop_code: '0101', stop_name: 'Loop A', osm_stop_name: 'Loop A' },
      { stop_id: 'LB', stop_code: '0201', stop_name: 'Loop B', osm_stop_name: 'Loop B' },
      { stop_id: 'LC', stop_code: '0301', stop_name: 'Loop C', osm_stop_name: 'Loop C' },
      { stop_id: 'LD', stop_code: '0401', stop_name: 'Loop D', osm_stop_name: 'Loop D' }
    ],
    calendar: {
      dateTypes: { '2026-10-30': 'weekday' },
      serviceIdsByDate: { '2026-10-30': ['SERVICE'] }
    },
  };
}

const fixture = createFixture();
const service = createDataContext(fixture);

// A realtime update ending at an intermediate stop must use the exact
// scheduled trip's real terminal. Only that physical trip is deduplicated.
const intermediateRealtimeBoard = {
  status: 'ok',
  generated_at: Math.floor(now.getTime() / 1000),
  skipped_trips: [],
  routes: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    direction_id: '',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    destination_stop_id: 'BOARD',
    times: [{
      timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000,
      scheduled_time: Date.parse('2026-10-30T13:40:00+02:00') / 1000,
      delay: 120
    }]
  }]
};

const merged = service.buildBoard(intermediateRealtimeBoard, '0200', now);
const trolley = merged.routes.find(route => route.route_id === 'TB7');
assert.ok(trolley, 'the TB7 row must be returned');
assert.equal(trolley.destination, 'Крайна спирка от OSM', 'the realtime intermediate stop must not replace the static trip terminal');
assert.deepEqual(
  trolley.times.map(time => [time.scheduled, Math.round(time.timestamp)]),
  [
    [false, Math.round(Date.parse('2026-10-30T13:42:00+02:00') / 1000)],
    [true, Math.round(Date.parse('2026-10-30T13:50:00+02:00') / 1000)],
    [true, Math.round(Date.parse('2026-10-30T14:00:00+02:00') / 1000)]
  ],
  'the realtime trip is shown once, and following static trips fill the row up to three times'
);
assert.equal(trolley.meta.number, '7', 'the API must return display-ready line metadata');

// Manual route overrides are shared by the API metadata builder.
const routeMetadata = require('../route-metadata');
const previousOverrides = routeMetadata.getRouteOverrides();
routeMetadata.setRouteOverrides({ TB7: { number: '7A', color: '#123456' } });
const overriddenBoard = service.buildBoard(intermediateRealtimeBoard, '0200', now);
const overriddenTrolley = overriddenBoard.routes.find(route => route.route_id === 'TB7');
assert.equal(overriddenTrolley.meta.number, '7A');
assert.equal(overriddenTrolley.meta.color, '#123456');
routeMetadata.setRouteOverrides(previousOverrides);

// A stop-specific projection must not bypass validation when the full
// TripUpdate descriptor for the same instance is present but malformed.
const malformedDescriptorProjectionBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7', trip_id: 'GTFS-TRIP-A', trip_start_date: '20261030',
    trip_start_time: '13:00:00', direction_id: 'D1', schedule_relationship: 0,
    times: [{
      timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000,
      event_type: 'arrival', stop_id: 'BOARD', stop_sequence: 2
    }]
  }],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A', route_id: 'TB7', trip_start_date: '20261030',
    trip_start_time: '13:00:00', direction_id: 'D1', schedule_relationship: 0,
    stop_time_updates: [
      { stop_id: 'BOARD', stop_sequence: 2, schedule_relationship: 0,
        arrival: { timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000 } },
      { stop_id: 'START', stop_sequence: 1, schedule_relationship: 0,
        departure: { timestamp: Date.parse('2026-10-30T13:02:00+02:00') / 1000 } }
    ]
  }]
}, '0200', now);
const malformedDescriptorProjectionRow = malformedDescriptorProjectionBoard.routes
  .find(route => route.route_id === 'TB7');
assert.ok(malformedDescriptorProjectionRow?.times.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
'a malformed full TripUpdate must leave the GTFS fallback visible');
assert.ok(!malformedDescriptorProjectionRow?.times.some(time => !time.scheduled),
'a direct projection must not bypass invalid StopTimeUpdate ordering');

// A supplied Trip ID is authoritative. An unknown ID must not be mapped to a
// scheduled GTFS course merely because a stop time happens to be close.
const mismatchedTripIdBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7',
    trip_id: 'NOT-GTFS-TRIP-A',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00',
    direction_id: 'D1',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    destination_stop_id: 'END',
    times: [{ timestamp: Date.parse('2026-10-30T13:41:00+02:00') / 1000 }]
  }],
  skipped_trips: []
}, '0200', now);
const mismatchedRow = mismatchedTripIdBoard.routes.find(route => route.route_id === 'TB7');
assert.ok(mismatchedRow, 'the route row must remain present');
assert.ok(mismatchedRow.times.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
'a SCHEDULED TripUpdate with an unknown Trip ID must leave the GTFS fallback visible');
assert.ok(!mismatchedRow.times.some(time => !time.scheduled),
  'an unknown SCHEDULED Trip ID must not be rendered as a matched GTFS trip');

// A service-date trip with GTFS times at or beyond 24:00 remains valid after
// midnight. Both static fallback and realtime matching use the previous
// service date rather than the current civil date.
const overnightFixture = createFixture();
overnightFixture.calendar = {
  dateTypes: { '2026-10-30': 'weekday', '2026-10-31': 'weekend' },
  serviceIdsByDate: { '2026-10-30': ['SERVICE'], '2026-10-31': [] }
};
overnightFixture.schedules.TB7.D1.weekday[0] = {
  trip_id: 1,
  original_trip_id: 'GTFS-OVERNIGHT',
  service_id: 'SERVICE',
  start_time: '24:00:00',
  stop_sequences: [1, 2, 3],
  times: ['24:00:00', '25:10:00', '25:30:00'],
  arrival_times: ['23:59:00', '25:09:00', '25:29:00']
};
const overnightService = createDataContext(overnightFixture);
const afterMidnight = new Date('2026-10-31T00:55:00+02:00');
const overnightStaticBoard = overnightService.buildBoard({ routes: [], skipped_trips: [] }, '0200', afterMidnight);
const overnightStaticTime = overnightStaticBoard.routes
  .flatMap(route => route.times)
  .find(time => time.trip_id === 'GTFS-OVERNIGHT' && time.scheduled);
assert.equal(overnightStaticTime?.timestamp, Date.parse('2026-10-31T01:09:00+02:00') / 1000,
  'a 25:09 GTFS arrival from the previous service date must be shown at 01:09 local time');
const overnightRealtimeBoard = overnightService.buildBoard({
  routes: [], skipped_trips: [], realtime_trips: [{
    trip_id: 'GTFS-OVERNIGHT', route_id: 'TB7', trip_start_date: '20261030',
    trip_start_time: '24:00:00', direction_id: 'D1', schedule_relationship: 0,
    stop_time_updates: [{
      stop_id: 'BOARD', stop_sequence: 2, schedule_relationship: 0,
      arrival: { timestamp: Date.parse('2026-10-31T01:12:00+02:00') / 1000 }
    }]
  }]
}, '0200', afterMidnight);
const overnightRealtimeTime = overnightRealtimeBoard.routes
  .flatMap(route => route.times)
  .find(time => time.source === 'realtime' && time.trip_id === 'GTFS-OVERNIGHT');
assert.equal(overnightRealtimeTime?.timestamp, Date.parse('2026-10-31T01:12:00+02:00') / 1000,
  'a TripDescriptor.start_date from the previous service day must resolve the correct realtime course');
assert.equal(overnightRealtimeTime?.scheduled_time, Date.parse('2026-10-31T01:09:00+02:00') / 1000,
  'realtime delay must be compared with the previous service date timetable');

// A valid descriptor using the exact GTFS trip ID replaces only that course's
// arrival. Its scheduled baseline is the GTFS arrival_time, not departure_time.
const exactTripIdBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7',
    trip_id: 'GTFS-TRIP-A',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00',
    direction_id: 'D1',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    destination_stop_id: 'END',
    times: [{ timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000, event_type: 'arrival' }]
  }],
  skipped_trips: []
}, '0200', now);
const exactTripRow = exactTripIdBoard.routes.find(route => route.route_id === 'TB7');
const exactRealtimeTime = exactTripRow.times.find(time => !time.scheduled);
assert.ok(exactRealtimeTime, 'a valid exact TripDescriptor must produce a realtime arrival');
assert.equal(exactRealtimeTime.trip_id, 'GTFS-TRIP-A');
assert.equal(exactRealtimeTime.scheduled_time, Date.parse('2026-10-30T13:39:00+02:00') / 1000,
  'the realtime arrival must retain the matching GTFS arrival baseline');
assert.ok(!exactTripRow.times.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'the matched static arrival must not appear beside its realtime replacement');

// Trip ID alone is sufficient when it unambiguously identifies the static
// trip; start_time remains optional for non-frequency-based scheduled trips.
const timestampOnlyRealtimeBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7', trip_id: 'GTFS-TRIP-A', trip_start_date: '20261030', direction_id: 'D1',
    schedule_relationship: 0, schedule_relationship_name: 'SCHEDULED',
    destination_stop_id: 'END',
    times: [{ timestamp: Date.parse('2026-10-30T13:43:00+02:00') / 1000, event_type: 'arrival' }]
  }],
  skipped_trips: []
}, '0200', now);
const timestampOnlyRealtimeTime = timestampOnlyRealtimeBoard.routes
  .flatMap(route => route.times)
  .find(time => time.source === 'realtime');
assert.equal(timestampOnlyRealtimeTime?.timestamp, Date.parse('2026-10-30T13:43:00+02:00') / 1000);
assert.equal(timestampOnlyRealtimeTime?.scheduled_time, Date.parse('2026-10-30T13:39:00+02:00') / 1000);

// route_id and start_time are optional when trip_id uniquely identifies the
// static trip. The service can resolve the route from the canonical Trip ID.
const tripIdOnlyBoard = service.buildBoard({
  routes: [{
    trip_id: 'GTFS-TRIP-A', trip_start_date: '20261030',
    schedule_relationship: 0, schedule_relationship_name: 'SCHEDULED',
    destination_stop_id: 'END',
    times: [{ timestamp: Date.parse('2026-10-30T13:43:00+02:00') / 1000, event_type: 'arrival' }]
  }],
  skipped_trips: []
}, '0200', now);
const tripIdOnlyRealtimeRow = tripIdOnlyBoard.routes.find(route => route.route_id === 'TB7');
assert.ok(tripIdOnlyRealtimeRow?.times.some(time => !time.scheduled
  && time.trip_id === 'GTFS-TRIP-A'),
  'a globally unique Trip ID must resolve even when route_id and start_time are omitted');

// A supplied start_date is part of the trip-instance identity and must match
// the service date being rendered.
const wrongDateBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7', trip_id: 'GTFS-TRIP-A', trip_start_date: '20261029',
    trip_start_time: '13:00:00', direction_id: 'D1', schedule_relationship: 0,
    times: [{ timestamp: Date.parse('2026-10-30T13:43:00+02:00') / 1000, event_type: 'arrival' }]
  }],
  skipped_trips: []
}, '0200', now);
assert.ok(wrongDateBoard.routes.find(route => route.route_id === 'TB7')?.times.some(time => time.scheduled),
  'a TripUpdate from another service date must not replace today’s static trip');
assert.ok(!wrongDateBoard.routes.flatMap(route => route.times).some(time => !time.scheduled),
  'a TripUpdate with a mismatched service date must not be rendered for today');

// If trip_id is omitted, GTFS requires route_id, direction_id, start_time and
// start_date together. That exact tuple must resolve to a single static trip.
const tripWithoutIdBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7',
    trip_id: '',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00',
    direction_id: 'D1',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    destination_stop_id: 'END',
    times: [{ timestamp: Date.parse('2026-10-30T13:44:00+02:00') / 1000, event_type: 'arrival' }]
  }],
  skipped_trips: []
}, '0200', now);
const noIdRealtimeRow = tripWithoutIdBoard.routes.find(route => route.route_id === 'TB7');
assert.ok(noIdRealtimeRow?.times.some(time => !time.scheduled
  && time.trip_id === 'GTFS-TRIP-A'),
  'the complete route/direction/date/start-time tuple must resolve a descriptor with no Trip ID');
assert.ok(!noIdRealtimeRow.times.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'the uniquely matched GTFS fallback must be replaced by the realtime arrival');

// Without the required date or direction, a descriptor with no Trip ID is
// ambiguous and must not suppress a static trip.
const incompleteNoIdBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7', trip_id: '', trip_start_time: '13:00:00', direction_id: 'D1',
    schedule_relationship: 0,
    destination_stop_id: 'END',
    times: [{ timestamp: Date.parse('2026-10-30T13:44:00+02:00') / 1000 }]
  }],
  skipped_trips: []
}, '0200', now);
assert.ok(incompleteNoIdBoard.routes.find(route => route.route_id === 'TB7')?.times.some(time => time.scheduled),
  'an incomplete descriptor without Trip ID must leave the timetable visible');

// A supplied direction or start_time that conflicts with the exact GTFS trip
// makes the realtime descriptor invalid; do not silently relax the match.
const mismatchedDirectionBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7', trip_id: 'GTFS-TRIP-A', trip_start_date: '20261030',
    trip_start_time: '13:00:00', direction_id: '0', schedule_relationship: 0,
    times: [{ timestamp: Date.parse('2026-10-30T13:44:00+02:00') / 1000 }]
  }],
  skipped_trips: []
}, '0200', now);
assert.ok(mismatchedDirectionBoard.routes.find(route => route.route_id === 'TB7')?.times.some(time => time.scheduled),
  'a conflicting direction_id must leave the static fallback visible');
assert.ok(!mismatchedDirectionBoard.routes.flatMap(route => route.times).some(time => !time.scheduled),
  'a SCHEDULED TripUpdate with a direction_id conflict must not be rendered');

// The production Sofia static dataset currently omits direction_id. A
// populated realtime direction_id must not invalidate an exact Trip ID match
// when static GTFS has no value to compare against.
const directionlessFixture = createFixture();
directionlessFixture.directions.TB7.D1.direction_id = '';
const directionlessService = createDataContext(directionlessFixture);
const realtimeDirectionWithoutStaticDirection = directionlessService.buildBoard({
  routes: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00',
    route_id: 'TB7',
    direction_id: '0',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    trip_update_timestamp: Date.parse('2026-10-30T13:00:00+02:00') / 1000,
    stop_time_updates: [{
      stop_id: 'BOARD', stop_sequence: 2, schedule_relationship: 0,
      arrival: { timestamp: Date.parse('2026-10-30T13:44:00+02:00') / 1000 },
      departure: null
    }]
  }],
  skipped_trips: []
}, '0200', now);
const directionlessRealtime = realtimeDirectionWithoutStaticDirection.routes.find(route => route.route_id === 'TB7');
assert.ok(directionlessRealtime?.times.some(time => !time.scheduled
  && time.trip_id === 'GTFS-TRIP-A'),
  'an exact Trip ID match must remain valid when static GTFS omits direction_id');

// When Trip ID is missing, a realtime direction_id can still be accepted if
// static GTFS omits direction_id and route + date + start_time resolves to one
// and only one static course. Ambiguous matches remain rejected.
const directionlessNoId = directionlessService.buildBoard({
  routes: [],
  realtime_trips: [{
    trip_id: '', trip_start_date: '20261030', trip_start_time: '13:00:00',
    route_id: 'TB7', direction_id: '0', schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    trip_update_timestamp: Date.parse('2026-10-30T13:00:00+02:00') / 1000,
    stop_time_updates: [{
      stop_id: 'BOARD', stop_sequence: 2, schedule_relationship: 0,
      arrival: { timestamp: Date.parse('2026-10-30T13:44:00+02:00') / 1000 },
      departure: null
    }]
  }],
  skipped_trips: []
}, '0200', now);
assert.ok(directionlessNoId.routes.find(route => route.route_id === 'TB7')?.times.some(time => !time.scheduled),
  'a descriptor without Trip ID may use a unique route/date/start_time match when static direction_id is absent');

const nearButNotExactStartBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7', trip_id: 'GTFS-TRIP-A', trip_start_date: '20261030',
    trip_start_time: '13:00:30', direction_id: 'D1', schedule_relationship: 0,
    times: [{ timestamp: Date.parse('2026-10-30T13:44:00+02:00') / 1000 }]
  }],
  skipped_trips: []
}, '0200', now);
assert.ok(nearButNotExactStartBoard.routes.find(route => route.route_id === 'TB7')?.times.some(time => time.scheduled),
  'a non-exact start_time must not be mapped to the static trip');

// The same GTFS template ID with a different start_time is not the same trip
// instance. A DUPLICATED update does not cancel the original trip.
const duplicatedRawTripInstanceBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7', trip_id: 'GTFS-TRIP-A', trip_start_date: '20261030',
    trip_start_time: '13:05:00', direction_id: 'D1',
    schedule_relationship: 6, schedule_relationship_name: 'DUPLICATED',
    destination_stop_id: 'END',
    times: [{ timestamp: Date.parse('2026-10-30T13:41:00+02:00') / 1000 }]
  }],
  skipped_trips: []
}, '0200', now);
assert.ok(duplicatedRawTripInstanceBoard.routes.find(route => route.route_id === 'TB7')?.times.some(time => time.scheduled),
  'a DUPLICATED TripUpdate must not replace or hide its original static trip');
assert.ok(!duplicatedRawTripInstanceBoard.routes.flatMap(route => route.times).some(time => !time.scheduled),
  'an unsupported duplicate instance must not be displayed with the original trip identity');

// An exact TripUpdate descriptor and stop-specific event replace the static
// arrival for that exact course.
const exactDescriptorBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A', route_id: 'TB7', trip_start_date: '20261030',
    trip_start_time: '13:00:00', direction_id: 'D1',
    schedule_relationship: 0, schedule_relationship_name: 'SCHEDULED',
    stop_time_updates: [{
      stop_id: 'BOARD', stop_sequence: 2, schedule_relationship: 0,
      arrival: { timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000, delay: 180 }
    }]
  }]
}, '0200', now);
const exactDescriptorRow = exactDescriptorBoard.routes.find(route => route.route_id === 'TB7');
assert.ok(exactDescriptorRow?.times.some(time => !time.scheduled && time.trip_id === 'GTFS-TRIP-A'),
  'an exact TripUpdate descriptor must produce a realtime arrival');
assert.ok(!exactDescriptorRow.times.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'the matching static arrival must not remain beside its realtime prediction');

// A valid descriptor without start_time still resolves by exact Trip ID.
const descriptorWithoutStartTimeBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A', route_id: 'TB7', trip_start_date: '20261030',
    trip_start_time: '', direction_id: 'D1',
    schedule_relationship: 0, schedule_relationship_name: 'SCHEDULED',
    stop_time_updates: [{
      stop_id: 'BOARD', stop_sequence: 2, schedule_relationship: 0,
      arrival: { timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000, delay: 180 }
    }]
  }]
}, '0200', now);
assert.ok(descriptorWithoutStartTimeBoard.routes.find(route => route.route_id === 'TB7')?.times.some(time => !time.scheduled),
  'a descriptor with the exact Trip ID may omit start_time when it is not needed to disambiguate the instance');

// A downstream-only StopTimeUpdate must not be used to infer an earlier stop.
const laterSegmentOnlyBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A', route_id: 'TB7', trip_start_date: '20261030',
    trip_start_time: '13:00:00', direction_id: 'D1',
    schedule_relationship: 0, schedule_relationship_name: 'SCHEDULED',
    stop_time_updates: [{
      stop_id: 'END', stop_sequence: 3, schedule_relationship: 0,
      arrival: { timestamp: Date.parse('2026-10-30T14:04:00+02:00') / 1000, delay: 120 }
    }]
  }]
}, '0200', now);
const laterSegmentOnlyTimes = laterSegmentOnlyBoard.routes.filter(route => route.route_id === 'TB7').flatMap(route => route.times);
assert.ok(laterSegmentOnlyTimes.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'a downstream-only update must leave the earlier stop schedule visible');
assert.ok(laterSegmentOnlyTimes.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:50:00+02:00') / 1000)),
  'a distinct later static course must remain visible');

// When the exact realtime arrival is already in the past, do not resurrect it
// from the future timetable; keep the next static trip visible.
const passedDescriptorBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A', route_id: 'TB7', trip_start_date: '20261030',
    trip_start_time: '13:00:00', direction_id: 'D1',
    schedule_relationship: 0, schedule_relationship_name: 'SCHEDULED',
    stop_time_updates: [{
      stop_id: 'BOARD', stop_sequence: 2, schedule_relationship: 0,
      arrival: { timestamp: Date.parse('2026-10-30T13:39:00+02:00') / 1000, delay: 0 }
    }]
  }]
}, '0200', new Date('2026-10-30T13:41:00+02:00'));
const passedTimes = passedDescriptorBoard.routes.filter(route => route.route_id === 'TB7').flatMap(route => route.times);
assert.ok(!passedTimes.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'an already-passed exact realtime prediction must suppress the same GTFS fallback');
assert.ok(passedTimes.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:50:00+02:00') / 1000)),
  'the next static trip must remain visible after the previous trip has passed');

// A duplicated realtime instance can reuse the same GTFS template Trip ID
// but carry a different start_time. It must not hide the original scheduled
// instance when the start times identify different runs.
const duplicatedTripInstanceBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    trip_start_date: '20261030',
    trip_start_time: '13:05:00',
    schedule_relationship: 6,
    schedule_relationship_name: 'DUPLICATED'
  }]
}, '0200', now);
const duplicatedTripTimes = duplicatedTripInstanceBoard.routes
  .filter(route => route.route_id === 'TB7')
  .flatMap(route => route.times);
assert.ok(
  duplicatedTripTimes.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'a DUPLICATED realtime instance with another start_time must not suppress the original static course'
);

// The time-based fallback remains available for feeds that omit Trip ID.
const realtimeWithoutTripIdBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00',
    destination_stop_id: 'END',
    direction_id: 'D1',
    times: [{
      timestamp: Date.parse('2026-10-30T13:41:00+02:00') / 1000,
      scheduled_time: Date.parse('2026-10-30T13:40:00+02:00') / 1000,
      delay: 60
    }]
  }],
  skipped_trips: []
}, '0200', now);
const noIdRow = realtimeWithoutTripIdBoard.routes.find(route => route.route_id === 'TB7');
assert.ok(noIdRow, 'a realtime row without Trip ID must still be displayed');
assert.ok(
  !noIdRow.times.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'the fallback should deduplicate the matching static trip when realtime omits Trip ID'
);

// An internal numeric schedule grouping ID is not a GTFS Trip ID and must
// never suppress a static fallback when a realtime feed happens to use the
// same text value as its actual trip_id.
const internalIdCollisionBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: '1',
    route_id: 'TB7',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00'
  }]
}, '0200', now);
const internalIdCollisionTimes = internalIdCollisionBoard.routes
  .filter(route => route.route_id === 'TB7')
  .flatMap(route => route.times);
assert.ok(
  internalIdCollisionTimes.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'an internal numeric schedule ID must not be mistaken for the original GTFS Trip ID'
);

// If Trip ID and trip start time are both omitted, scheduled_time metadata
// from a SCHEDULED trip is invalid and cannot be used to guess an identity.
const noIdNoStartTimeBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7',
    destination_stop_id: 'END',
    times: [{
      timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000,
      scheduled_time: Date.parse('2026-10-30T13:40:00+02:00') / 1000,
      delay: 120
    }]
  }],
  skipped_trips: []
}, '0200', now);
const noIdNoStartTimes = noIdNoStartTimeBoard.routes
  .filter(route => route.route_id === 'TB7')
  .flatMap(route => route.times);
assert.ok(
  noIdNoStartTimes.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'without a Trip ID or start_time, a scheduled_time field must not be used to guess which GTFS trip is being updated'
);
assert.ok(
  noIdNoStartTimes.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:50:00+02:00') / 1000)),
  'the exact-time fallback match must not suppress the next different course'
);

// A different scheduled time must no longer be merged just because it falls
// within the old two-minute tolerance, even when route and terminal match.
const nearbyNoIdBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7',
    destination_stop_id: 'END',
    times: [{
      timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000,
      scheduled_time: Date.parse('2026-10-30T13:41:00+02:00') / 1000,
      delay: 60
    }]
  }],
  skipped_trips: []
}, '0200', now);
const nearbyNoIdRow = nearbyNoIdBoard.routes.find(route => route.route_id === 'TB7');
assert.ok(
  nearbyNoIdRow.times.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'a one-minute scheduled-time difference must not suppress a distinct static course'
);

// Without Trip ID or start_time there is no safe static-trip identity. A
// StopTimeEvent.time must not be reverse-engineered with delay to create one:
// GTFS-Realtime gives absolute time precedence when both are present.
const sequenceOnlyPartialNoIdBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    route_id: 'TB7',
    direction_id: 'D1',
    schedule_relationship: 0,
    stop_time_updates: [{
      stop_sequence: 3,
      arrival: {
        timestamp: Date.parse('2026-10-30T14:04:00+02:00') / 1000,
        delay: 60
      }
    }]
  }]
}, '0200', now);
const sequenceOnlyPartialTimes = sequenceOnlyPartialNoIdBoard.routes
  .filter(route => route.route_id === 'TB7')
  .flatMap(route => route.times);
assert.ok(sequenceOnlyPartialTimes.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
'a sequence-only update without Trip ID or start_time must not suppress a static course it cannot identify safely');
assert.ok(sequenceOnlyPartialTimes.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:50:00+02:00') / 1000)),
'sequence-only partial realtime matching must not suppress the next course on the same line');

// A bare TripUpdate descriptor identifies a course but has no realtime
// timing data. Keep its GTFS fallback until at least one timed update exists.
const realtimeCourseWithoutStopPrediction = service.buildBoard({
  status: 'empty',
  generated_at: Math.floor(now.getTime() / 1000),
  skipped_trips: [],
  routes: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00'
  }]
}, '0200', now);
const noPredictionTimes = realtimeCourseWithoutStopPrediction.routes
  .filter(route => route.route_id === 'TB7')
  .flatMap(route => route.times.map(time => Math.round(time.timestamp)));
assert.ok(
  noPredictionTimes.includes(Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'a TripUpdate without a prediction at or before the selected stop must leave the GTFS fallback visible'
);
assert.ok(
  noPredictionTimes.includes(Math.round(Date.parse('2026-10-30T13:50:00+02:00') / 1000)),
  'unrelated static courses on the same line must remain visible'
);

// If the realtime arrival has already passed but the timetable time is still
// in the future, do not resurrect that same course from static data. The next
// course must become the first visible departure instead.
const staleRealtimeCourseBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00',
    schedule_relationship: 0,
    stop_time_updates: [{
      stop_sequence: 2,
      schedule_relationship: 0,
      arrival: { timestamp: Math.floor(now.getTime() / 1000) - 60 }
    }]
  }]
}, '0200', now);
const passedCourseTimes = staleRealtimeCourseBoard.routes
  .filter(route => route.route_id === 'TB7')
  .flatMap(route => route.times);
assert.ok(
  !passedCourseTimes.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'a past realtime arrival must not reappear as its future static timetable time'
);
assert.ok(
  passedCourseTimes.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:50:00+02:00') / 1000)),
  'the next course must remain visible after the previous realtime course has passed'
);

// TripUpdate.delay is propagated from the start of a scheduled trip until a
// StopTimeUpdate changes it. The matching static trip becomes a realtime row
// even before a stop-specific prediction has been emitted.
const tripLevelDelayBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00',
    trip_delay: 300,
    stop_time_updates: [{
      stop_sequence: 3,
      schedule_relationship: 0,
      arrival: { delay: 0 }
    }]
  }]
}, '0200', now);
const tripLevelDelayRow = tripLevelDelayBoard.routes.find(route =>
  route.route_id === 'TB7' && route.trip_id === 'GTFS-TRIP-A'
);
assert.ok(tripLevelDelayRow, 'trip-level delay should produce a realtime row before the vehicle leaves its origin');
assert.equal(tripLevelDelayRow.realtime, true, 'the inferred prediction must be marked as realtime');
assert.ok(
  tripLevelDelayRow.times.some(time => Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:44:00+02:00') / 1000)),
  'trip-level delay should be applied to the selected stop scheduled time'
);
assert.ok(
  !tripLevelDelayRow.times.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'the realtime trip must not also appear as a static fallback'
);

// StopTimeUpdates with stop_sequence but no stop_id are valid GTFS-Realtime
// updates. Their delay propagates to the selected downstream stop.
const sequenceOnlyDelayBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00',
    stop_time_updates: [{
      stop_sequence: 1,
      schedule_relationship: 0,
      departure: {
        timestamp: Date.parse('2026-10-30T13:05:00+02:00') / 1000,
        delay: 300
      }
    }]
  }]
}, '0200', now);
const sequenceOnlyDelayRow = sequenceOnlyDelayBoard.routes.find(route =>
  route.route_id === 'TB7' && route.trip_id === 'GTFS-TRIP-A'
);
assert.ok(sequenceOnlyDelayRow, 'a stop_sequence-only update should be mapped to the GTFS stop');
assert.ok(
  sequenceOnlyDelayRow.times.some(time => Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:44:00+02:00') / 1000)),
  'the sequence-only stop delay should propagate to the selected stop'
);

// When both StopTimeEvent.time and delay are present, absolute time wins.
// Arrival events must be compared with static arrival_time, not departure_time.
const arrivalTimeWinsBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00',
    trip_update_timestamp: Math.floor(now.getTime() / 1000),
    stop_time_updates: [{
      stop_id: 'BOARD',
      stop_sequence: 2,
      schedule_relationship: 0,
      arrival: {
        timestamp: Date.parse('2026-10-30T13:41:00+02:00') / 1000,
        delay: -120
      }
    }]
  }]
}, '0200', now);
const arrivalTimeWinsRow = arrivalTimeWinsBoard.routes.find(route =>
  route.route_id === 'TB7' && route.trip_id === 'GTFS-TRIP-A'
);
assert.ok(arrivalTimeWinsRow, 'an absolute arrival prediction should replace the selected static course');
assert.ok(arrivalTimeWinsRow.times.some(time =>
  Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:41:00+02:00') / 1000)
    && time.delay === 120
    && Math.round(time.scheduled_time) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)
    && time.event_type === 'arrival'
), 'StopTimeEvent.time must take precedence over delay and use matching GTFS arrival_time');

// If stop_sequence and stop_id are both present, they must identify the same
// stop in the static trip. Otherwise the realtime descriptor is rejected and
// the static timetable remains available.
const mismatchedStopReferenceBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00',
    stop_time_updates: [{
      stop_id: 'START',
      stop_sequence: 2,
      schedule_relationship: 0,
      arrival: { timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000 }
    }]
  }]
}, '0200', now);
assert.ok(mismatchedStopReferenceBoard.routes.some(route =>
  route.route_id === 'TB7' && route.times.some(time => time.trip_id === 'GTFS-TRIP-A'
    && time.scheduled
    && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000))
), 'a stop_id/stop_sequence mismatch must not suppress the GTFS fallback');

// Direct grouped realtime rows must apply the same stop_id/stop_sequence
// validation as the complete TripUpdate descriptor path.
const mismatchedDirectStopBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7', trip_id: 'GTFS-TRIP-A', trip_start_date: '20261030',
    trip_start_time: '13:00:00', direction_id: 'D1', schedule_relationship: 0,
    times: [{
      timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000,
      event_type: 'arrival', stop_id: 'START', stop_sequence: 2
    }]
  }],
  skipped_trips: []
}, '0200', now);
assert.ok(mismatchedDirectStopBoard.routes.find(route => route.route_id === 'TB7')?.times.some(time => time.scheduled),
  'a direct realtime row with conflicting stop_id/stop_sequence must leave GTFS visible');
assert.ok(!mismatchedDirectStopBoard.routes.flatMap(route => route.times).some(time => !time.scheduled),
  'a direct realtime row with an invalid stop reference must not be shown');

// GTFS stop_id values are opaque strings: leading zeroes are meaningful and
// must not be stripped when validating a StopTimeUpdate reference.
const zeroPaddedFixture = createFixture();
zeroPaddedFixture.directions.TB7.D1.pattern = ['0605', 'BOARD', 'END'];
zeroPaddedFixture.directions.TB7.D1.stops[0] = { stop_id: '0605', osm_name: 'Спирка 0605' };
zeroPaddedFixture.stops.push({ stop_id: '0605', stop_code: '0205', stop_name: 'Спирка 0605' });
const zeroPaddedService = createDataContext(zeroPaddedFixture);
const zeroPaddedBoard = zeroPaddedService.buildBoard({
  routes: [], skipped_trips: [], realtime_trips: [{
    trip_id: 'GTFS-TRIP-A', route_id: 'TB7', trip_start_date: '20261030',
    trip_start_time: '13:00:00', direction_id: 'D1', schedule_relationship: 0,
    stop_time_updates: [{
      stop_id: '605', stop_sequence: 1, schedule_relationship: 0,
      arrival: { timestamp: Date.parse('2026-10-30T13:02:00+02:00') / 1000 }
    }]
  }]
}, '0205', new Date('2026-10-30T12:55:00+02:00'));
assert.ok(zeroPaddedBoard.routes.find(route => route.route_id === 'TB7')?.times.some(time => time.scheduled),
  'stop_id 605 must not be treated as the distinct GTFS stop_id 0605');
assert.ok(!zeroPaddedBoard.routes.flatMap(route => route.times).some(time => !time.scheduled),
  'a leading-zero stop_id mismatch must not create a realtime prediction');

// Static schedule indexing must preserve every occurrence of a stop on a loop route.
const loopStaticBoard = service.buildBoard({ routes: [], skipped_trips: [] }, '0201', now);
const loopStaticTimes = loopStaticBoard.routes
  .filter(route => route.route_id === 'LOOP')
  .flatMap(route => route.times || [])
  .filter(time => time.trip_id === 'LOOP-TRIP-A' && time.scheduled)
  .map(time => Math.round(time.timestamp));
assert.ok(loopStaticTimes.includes(Math.round(Date.parse('2026-10-30T13:10:00+02:00') / 1000)),
  'the first visit to a repeated stop must have its own static arrival');
assert.ok(loopStaticTimes.includes(Math.round(Date.parse('2026-10-30T13:40:00+02:00') / 1000)),
  'the second visit to a repeated stop must have its own static arrival');

// A loop route may visit the same stop more than once. stop_sequence must
// select the exact visit: the first pass remains static while the second is
// replaced by its realtime prediction.
const repeatedStopBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'LOOP-TRIP-A',
    route_id: 'LOOP',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00',
    stop_time_updates: [{
      stop_id: 'LB',
      stop_sequence: 40,
      schedule_relationship: 0,
      arrival: { timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000 }
    }]
  }]
}, '0201', now);
const repeatedStopTimes = repeatedStopBoard.routes
  .filter(route => route.route_id === 'LOOP')
  .flatMap(route => route.times || []);
assert.ok(repeatedStopTimes.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:10:00+02:00') / 1000)),
'a realtime update for the second visit must not suppress the first visit');
assert.ok(repeatedStopTimes.some(time => !time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:42:00+02:00') / 1000)),
'a stop_sequence-specific realtime update must replace the matching repeated-stop visit');

// A SKIPPED update for the second visit to a loop stop must not suppress
// the first visit to the same stop_id.
const skippedSecondLoopVisitBoard = service.buildBoard({
  routes: [],
  skipped_trips: [{
    route_id: 'LOOP',
    trip_id: 'LOOP-TRIP-A',
    stop_id: 'LB',
    stop_sequence: 40
  }],
  realtime_trips: [{
    trip_id: 'LOOP-TRIP-A',
    route_id: 'LOOP',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00',
    stop_time_updates: [{
      stop_id: 'LB',
      stop_sequence: 40,
      schedule_relationship: 1
    }]
  }]
}, '0201', now);
const skippedLoopTimes = skippedSecondLoopVisitBoard.routes
  .filter(route => route.route_id === 'LOOP')
  .flatMap(route => route.times || []);
assert.ok(skippedLoopTimes.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:10:00+02:00') / 1000)),
'a SKIPPED update for stop_sequence 40 must leave the stop_sequence 20 arrival visible');
assert.ok(!skippedLoopTimes.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:40:00+02:00') / 1000)),
'a SKIPPED update must suppress only the matching stop_sequence visit');

// When static GTFS has both arrival_time and departure_time for a stop,
// a SCHEDULED StopTimeUpdate must provide both corresponding events.
const strictEventFixture = createFixture();
strictEventFixture.schedules.TB7.D1.weekday[0].has_arrival = [true, true, true];
strictEventFixture.schedules.TB7.D1.weekday[0].has_departure = [true, true, true];
const strictEventService = createDataContext(strictEventFixture);
const incompleteBothEventsBoard = strictEventService.buildBoard({
  routes: [], skipped_trips: [], realtime_trips: [{
    trip_id: 'GTFS-TRIP-A', route_id: 'TB7', trip_start_date: '20261030',
    trip_start_time: '13:00:00', direction_id: 'D1', schedule_relationship: 0,
    stop_time_updates: [{
      stop_id: 'BOARD', stop_sequence: 2, schedule_relationship: 0,
      arrival: { timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000 }
    }]
  }]
}, '0200', now);
const incompleteBothEventsTimes = incompleteBothEventsBoard.routes
  .filter(route => route.route_id === 'TB7').flatMap(route => route.times);
assert.ok(incompleteBothEventsTimes.some(time => time.scheduled
  && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'a malformed one-event update must leave its GTFS arrival fallback visible');
assert.ok(!incompleteBothEventsTimes.some(time => !time.scheduled),
  'a stop with both static events must not accept an incomplete one-event update');

const completeBothEventsBoard = strictEventService.buildBoard({
  routes: [], skipped_trips: [], realtime_trips: [{
    trip_id: 'GTFS-TRIP-A', route_id: 'TB7', trip_start_date: '20261030',
    trip_start_time: '13:00:00', direction_id: 'D1', schedule_relationship: 0,
    stop_time_updates: [{
      stop_id: 'BOARD', stop_sequence: 2, schedule_relationship: 0,
      arrival: { timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000 },
      departure: { timestamp: Date.parse('2026-10-30T13:43:00+02:00') / 1000 }
    }]
  }]
}, '0200', now);
assert.ok(completeBothEventsBoard.routes.some(route => route.route_id === 'TB7'
  && route.times.some(time => !time.scheduled
    && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:42:00+02:00') / 1000))),
  'a complete arrival/departure update must be accepted when both static events exist');

// scheduled_time is forbidden for a SCHEDULED TripUpdate. Ignore that
// malformed update instead of turning it into a prediction or suppressing GTFS.
const forbiddenScheduledTimeBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00',
    stop_time_updates: [{
      stop_id: 'BOARD',
      stop_sequence: 2,
      schedule_relationship: 0,
      arrival: {
        timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000,
        scheduled_time: Date.parse('2026-10-30T13:40:00+02:00') / 1000
      }
    }]
  }]
}, '0200', now);
assert.ok(forbiddenScheduledTimeBoard.routes.some(route =>
  route.route_id === 'TB7' && route.times.some(time => time.trip_id === 'GTFS-TRIP-A'
    && time.scheduled
    && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000))
), 'a SCHEDULED StopTimeEvent with forbidden scheduled_time must fall back to static GTFS');

// NO_DATA clears an earlier trip-level delay for all subsequent stops; it
// must not be guessed through that point.
const noDataClearsDelayBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    trip_start_date: '20261030',
    trip_start_time: '13:00:00',
    trip_delay: 300,
    stop_time_updates: [{ stop_sequence: 1, schedule_relationship: 2 }]
  }]
}, '0200', now);
const noDataClearsDelayTimes = noDataClearsDelayBoard.routes
  .filter(route => route.route_id === 'TB7')
  .flatMap(route => route.times);
assert.ok(
  !noDataClearsDelayTimes.some(time => Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:45:00+02:00') / 1000)),
  'NO_DATA must stop delay propagation rather than inventing a downstream realtime estimate'
);
assert.ok(
  noDataClearsDelayTimes.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'NO_DATA must clear inherited delay and restore the original GTFS arrival at the selected stop'
);
assert.ok(
  noDataClearsDelayTimes.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:50:00+02:00') / 1000)),
  'NO_DATA handling must not suppress unrelated later courses on the same line'
);

// An expired realtime prediction is retained only for a short ten-second
// tolerance, not for the previous full minute.
const staleRealtimeBoard = service.buildBoard({
  routes: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    schedule_relationship: 0,
    times: [{ timestamp: now.getTime() / 1000 - 11 }]
  }],
  skipped_trips: []
}, '0200', now);
const staleRealtimeTimes = staleRealtimeBoard.routes
  .filter(route => route.route_id === 'TB7')
  .flatMap(route => route.times);
assert.ok(
  !staleRealtimeTimes.some(time => Math.round(time.timestamp) === Math.round(now.getTime() / 1000 - 11)),
  'a realtime course should stop appearing shortly after its predicted arrival'
);
const justPassedRealtimeBoard = service.buildBoard({
  routes: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    schedule_relationship: 0,
    times: [{ timestamp: now.getTime() / 1000 - 1 }]
  }],
  skipped_trips: []
}, '0200', now);

assert.ok(
  !justPassedRealtimeBoard.routes.some(route => route.route_id === 'TB7'
    && route.times.some(time => Math.round(time.timestamp) === Math.round(now.getTime() / 1000 - 1))),
  'a realtime course should be removed immediately after its predicted arrival'
);

// A CANCELED TripUpdate also suppresses the static fallback for that exact
// course; it must not reappear merely because the realtime course is hidden.
const canceledCourseBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    trip_start_date: '20261030',
    schedule_relationship: 3,
    schedule_relationship_name: 'CANCELED'
  }]
}, '0200', now);
const canceledCourseTimes = canceledCourseBoard.routes
  .filter(route => route.route_id === 'TB7')
  .flatMap(route => route.times.map(time => Math.round(time.timestamp)));
assert.ok(
  !canceledCourseTimes.includes(Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'a canceled realtime course must not reappear through static fallback'
);

// SKIPPED applies to the specific trip and stop only.
const skippedBoard = service.buildBoard({
  status: 'empty',
  generated_at: Math.floor(now.getTime() / 1000),
  skipped_trips: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    stop_id: 'BOARD',
    stop_sequence: 2
  }],
  routes: []
}, '0200', now);
const skippedTimes = skippedBoard.routes.find(route => route.route_id === 'TB7').times;
assert.ok(
  !skippedTimes.some(time => Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:39:00+02:00') / 1000)),
  'the exact skipped trip must not be shown'
);
assert.ok(
  skippedTimes.some(time => Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:50:00+02:00') / 1000)),
  'a different trip on the same line and direction must remain visible'
);

// A course is hidden at its own terminal, including a partial course whose
// last populated GTFS time is an intermediate stop in the full line pattern.
const boardAtIntermediateStop = service.buildBoard({ routes: [], skipped_trips: [] }, '0200', now);
const intermediateRows = boardAtIntermediateStop.routes.filter(route => route.route_id === 'TB7');
assert.ok(intermediateRows.some(route => route.terminal_stop_id === 'END'), 'full courses continuing beyond this stop remain visible');
assert.ok(
  !intermediateRows.some(route => route.terminal_stop_id === 'BOARD'),
  'a short-turn course ending at the selected stop must be hidden'
);

const terminalBoard = service.buildBoard({ routes: [], skipped_trips: [] }, '0300', now);
assert.ok(
  !terminalBoard.routes.some(route => route.route_id === 'TB7'),
  'full courses ending at the selected terminal stop must be hidden'
);

// The same terminal rule applies to realtime SCHEDULED trips. The GTFS trip
// record, not the last realtime StopTimeUpdate, determines the true endpoint.
const realtimeFullTripAtTerminal = service.buildBoard({
  routes: [{
    route_id: 'TB7',
    trip_id: 'GTFS-TRIP-A',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    destination_stop_id: 'BOARD',
    times: [{ timestamp: Date.parse('2026-10-30T14:03:00+02:00') / 1000 }]
  }],
  skipped_trips: []
}, '0300', now);
assert.ok(
  !realtimeFullTripAtTerminal.routes.some(route => route.route_id === 'TB7'),
  'a realtime full trip must be hidden at its GTFS terminal even if realtime only reports an earlier stop'
);

const realtimePartialTripAtTerminal = service.buildBoard({
  routes: [{
    route_id: 'TB7',
    trip_id: 'GTFS-PARTIAL-TRIP',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    destination_stop_id: 'END',
    times: [{ timestamp: Date.parse('2026-10-30T13:30:00+02:00') / 1000 }]
  }],
  skipped_trips: []
}, '0200', now);
const partialRealtimeRow = realtimePartialTripAtTerminal.routes.find(route => route.route_id === 'TB7');
assert.ok(partialRealtimeRow, 'other full-length TB7 courses must remain visible at this intermediate stop');
assert.ok(
  !partialRealtimeRow.times.some(time => Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:30:00+02:00') / 1000)),
  'the realtime short-turn trip must be hidden at its own partial terminal'
);
assert.ok(
  realtimePartialTripAtTerminal.routes.every(route => route.terminal_stop_id !== 'BOARD'),
  'the API must not return a destination ending at the selected stop'
);

// Static timetable courses are limited to the next two hours, inclusive of
// the exact two-hour boundary.
const twoHourNow = new Date('2026-10-30T14:58:00+02:00');
const twoHourBoard = service.buildBoard({ routes: [], skipped_trips: [] }, '0200', twoHourNow);
const twoHourRows = twoHourBoard.routes.filter(route => route.route_id === 'TB7');
const twoHourTimestamps = twoHourRows.flatMap(route => route.times.map(time => Math.round(time.timestamp)));
assert.ok(
  twoHourTimestamps.includes(Math.round(Date.parse('2026-10-30T16:58:00+02:00') / 1000)),
  'a static course exactly two hours ahead must remain visible'
);
assert.ok(
  !twoHourTimestamps.includes(Math.round(Date.parse('2026-10-30T16:59:00+02:00') / 1000)),
  'a static course more than two hours ahead must be excluded'
);

// Metro remains schedule-only and can resolve a station when the public stop
// code does not contain the M prefix.
const metroBoard = service.buildBoard({
  routes: [{ route_id: 'M1', trip_id: 'METRO-RT', times: [{ timestamp: Date.parse('2026-10-30T13:10:00+02:00') / 1000 }] }],
  skipped_trips: []
}, '1', now);
const metroRow = metroBoard.routes.find(route => route.route_id === 'M1');
assert.ok(metroRow, 'metro static departures must be included');
assert.equal(metroRow.destination, 'Метростанция Крайна');
assert.equal(metroRow.meta.type, 'metro');
assert.equal(metroRow.meta.number, '1', 'metro line numbers must be displayed without the M prefix');
assert.ok(metroRow.times.every(time => time.scheduled), 'metro board rows remain timetable-based');

// Explicit calendar overrides take precedence over a weekday fallback when
// no precomputed dateTypes entry is present.
const overrideFixture = createFixture();
overrideFixture.calendar.dateTypes = {};
overrideFixture.calendar.config = { dateOverrides: { '2026-10-30': 'weekend' } };
overrideFixture.schedules.TB7.D1.weekend = [{
  trip_id: 20,
  original_trip_id: 'WEEKEND-TRIP',
  service_id: 'SERVICE',
  start_time: '13:11:00',
  stop_sequences: [1, 2, 3],
  times: ['13:11:00', '13:51:00', '14:14:00']
}];
const overrideService = createDataContext(overrideFixture);
const overrideBoard = overrideService.buildBoard({ routes: [], skipped_trips: [] }, '0200', now);
const overrideTimes = overrideBoard.routes.find(route => route.route_id === 'TB7').times;
assert.ok(
  overrideTimes.some(time => Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:51:00+02:00') / 1000)),
  'the configured weekend schedule should be selected for the override date'
);

// Use the real GTFS for TB7 to ensure the API-side terminal lookup works with
// the production data, not only with a synthetic fixture.
const actual = createDataContext();
const actualRoutes = require('../data/routes.json');
const actualDirections = require('../data/directions.json');
const actualSchedules = require('../data/schedules.json');

// Regression for the live SofiaTraffic feed: its stop IDs are A-prefixed,
// while this project's static GTFS stop IDs are unprefixed. The exact A100
// course shown by the user's board at stop 0141 must therefore render realtime.
const actualA100Course = actualSchedules.A100?.D2?.weekend?.find(row =>
  row.original_trip_id === 'A100-A674-2-18-12007370960'
);
assert.ok(actualA100Course, 'the actual GTFS must contain the A100 diagnostic trip');
const actualSofiaNow = new Date('2026-11-14T18:11:35+02:00');
const actualA100RealtimeTimestamp = Date.parse('2026-11-14T18:16:00+02:00') / 1000;
const actualA100RealtimeBoard = actual.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'A100-A674-2-18-12007370960',
    route_id: 'A100',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    trip_update_timestamp: Math.floor(actualSofiaNow.getTime() / 1000) - 1,
    stop_time_updates: [{
      stop_id: 'A0141',
      stop_sequence: null,
      schedule_relationship: 0,
      arrival: { timestamp: actualA100RealtimeTimestamp }
    }]
  }]
}, '0141', actualSofiaNow);
assert.ok(
  actualA100RealtimeBoard.routes.some(route => route.route_id === 'A100'
    && route.times.some(time => time.source === 'realtime'
      && time.scheduled === false
      && Math.round(time.timestamp) === actualA100RealtimeTimestamp)),
  'the A-prefixed live stop ID A0141 must produce a realtime arrival for stop 0141'
);

// The static-data generator removes mode prefixes from surface stop IDs.
// SofiaTraffic retains TB for trolleybuses, so the resolver must adapt TB0141
// only when the already-matched static route is a trolley route.
const actualTB2TripId = 'TB2-TB613-1-20-14357986210';
const actualTB2Course = actualSchedules.TB2?.D2?.weekend?.find(row =>
  row.original_trip_id === actualTB2TripId
);
assert.ok(actualTB2Course, 'the actual GTFS must contain the TB2 diagnostic trolley trip');
const actualTB2RealtimeBoard = actual.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: actualTB2TripId,
    route_id: 'TB2',
    trip_start_date: '20261114',
    trip_start_time: '18:09:00',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    trip_update_timestamp: Math.floor(actualSofiaNow.getTime() / 1000) - 1,
    stop_time_updates: [{
      stop_id: 'TB0141',
      stop_sequence: 4,
      schedule_relationship: 0,
      arrival: { timestamp: actualA100RealtimeTimestamp - 180 }
    }]
  }]
}, '0141', actualSofiaNow);
assert.ok(
  actualTB2RealtimeBoard.routes.some(route => route.route_id === 'TB2'
    && route.times.some(time => time.source === 'realtime' && !time.scheduled
      && Math.round(time.timestamp) === actualA100RealtimeTimestamp - 180)),
  'the TB-prefixed live stop ID TB0141 must produce a realtime trolley arrival for stop 0141'
);

// Do not generalize the adapter into arbitrary digit extraction: unknown
// prefixes remain unmapped and must leave the static GTFS fallback visible.
const actualA100UnknownPrefixBoard = actual.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'A100-A674-2-18-12007370960',
    route_id: 'A100',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    trip_update_timestamp: Math.floor(actualSofiaNow.getTime() / 1000) - 1,
    stop_time_updates: [{
      stop_id: 'B0141',
      stop_sequence: null,
      schedule_relationship: 0,
      arrival: { timestamp: actualA100RealtimeTimestamp }
    }]
  }]
}, '0141', actualSofiaNow);
assert.ok(
  actualA100UnknownPrefixBoard.routes.some(route => route.route_id === 'A100'
    && route.times.some(time => time.scheduled === true
      && Math.round(time.timestamp) === actualA100RealtimeTimestamp)),
  'an unknown stop-ID prefix must not be accepted and the schedule fallback must remain'
);

const actualA100WrongModePrefixBoard = actual.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'A100-A674-2-18-12007370960',
    route_id: 'A100',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    trip_update_timestamp: Math.floor(actualSofiaNow.getTime() / 1000) - 1,
    stop_time_updates: [{
      stop_id: 'TB0141',
      stop_sequence: null,
      schedule_relationship: 0,
      arrival: { timestamp: actualA100RealtimeTimestamp }
    }]
  }]
}, '0141', actualSofiaNow);
assert.ok(
  !actualA100WrongModePrefixBoard.routes.some(route => route.route_id === 'A100'
    && route.times.some(time => time.source === 'realtime' || time.scheduled === false)),
  'a trolleybus stop namespace must not be accepted for a bus route'
);
const actualRoute = actualRoutes.find(route => route.route_id === 'TB7');
assert.ok(actualRoute, 'the actual data must contain trolleybus 7');
const actualDirection = Object.entries(actualDirections.TB7 || {}).find(([, direction]) =>
  Array.isArray(direction.pattern) && direction.pattern.map(String).includes('2082')
);
assert.ok(actualDirection, 'the actual TB7 direction must serve stop 2082');
const [actualDirectionKey, direction] = actualDirection;
const stopIndex = direction.pattern.map(String).indexOf('2082');
const actualRow = (actualSchedules.TB7?.[actualDirectionKey]?.weekday || []).find(row =>
  row.original_trip_id && row.times?.[stopIndex] === '13:40:00'
);
assert.ok(actualRow, 'the actual timetable must contain a 13:40 TB7 trip at stop 2082');
const actualTerminalIndex = actualRow.times.map((value, index) => value ? index : -1).filter(index => index >= 0).pop();
const actualTerminalId = String(direction.pattern[actualTerminalIndex]);
const actualTripTime = Date.parse('2026-11-16T13:40:00+02:00') / 1000;
const actualNow = new Date('2026-11-16T13:35:00+02:00');
const actualBoard = actual.buildBoard({
  routes: [{
    trip_id: actualRow.original_trip_id,
    route_id: 'TB7',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    destination_stop_id: '2082',
    times: [{ timestamp: actualTripTime + 90, scheduled_time: actualTripTime, delay: 90 }]
  }],
  skipped_trips: []
}, '2082', actualNow);
const actualTrolley = actualBoard.routes.find(route =>
  route.route_id === 'TB7' && route.times.some(time => Math.round(time.timestamp) === actualTripTime + 90)
);
assert.ok(actualTrolley, 'the actual TB7 realtime trip must be present');
assert.equal(actualTrolley.terminal_stop_id, actualTerminalId, 'the API must replace the intermediate realtime endpoint with the course terminal');

// Production GTFS contains genuine TB7 short-turn trips whose final populated
// stop time is 0803 (ж.к. Банишора), before the full D1 terminal 0610. Those
// trips must not be displayed on a board at 0803, while full trips continuing
// to 0610 must remain visible there.
// Use the current checked-in calendar's first covered date so this test
// checks terminal handling rather than an intentionally inactive day.
const actualShortTurnBoard = actual.buildBoard({ routes: [], skipped_trips: [] }, '0803', new Date('2026-11-16T20:00:00+02:00'));
const actualShortTurnRows = actualShortTurnBoard.routes.filter(route => route.route_id === 'TB7');
assert.ok(actualShortTurnRows.some(route => route.terminal_stop_id === '0610'), 'full TB7 trips continuing beyond 0803 must remain visible');
assert.ok(
  actualShortTurnRows.every(route => route.terminal_stop_id !== '0803'),
  'real partial TB7 trips ending at 0803 must be hidden at that stop'
);

// Production GTFS regression for tram 22: these actual courses serve
// 0633 -> 2086 -> 0470 -> 2023. If realtime starts only at 0470, earlier
// stops must retain their GTFS arrival while 0470 uses realtime and keeps the
// true GTFS terminal destination (2023).
const tm22Direction = actualDirections.TM22?.D2;
assert.ok(tm22Direction, 'production GTFS must contain tram 22 direction D2');
const tm22Pattern = tm22Direction.pattern.map(String);
const tm22Indexes = ['0633', '2086', '0470', '2023'].map(stopId => tm22Pattern.indexOf(stopId));
assert.ok(tm22Indexes.every(index => index >= 0), 'tram 22 D2 must include all four regression stops');
const tm22Course = (actualSchedules.TM22?.D2?.weekday || []).find(row =>
  row.original_trip_id === 'TM22-TM4-7-2-17666667941'
);
assert.ok(tm22Course, 'production GTFS must contain the selected full tram 22 course');
assert.deepEqual(tm22Indexes.map(index => tm22Course.times[index]), ['05:06:00', '05:20:00', '05:37:00', '05:47:00']);
const tm22TripDate = '20261116';
const tm22NowBefore2086 = new Date('2026-11-16T05:10:00+02:00');
const tm22UpdateAt0470 = Date.parse('2026-11-16T05:38:00+02:00') / 1000;
const tm22UpdateAt2023 = Date.parse('2026-11-16T05:48:00+02:00') / 1000;
const tm22RealtimeTrip = {
  trip_id: tm22Course.original_trip_id,
  route_id: 'TM22',
  trip_start_date: tm22TripDate,
  trip_start_time: tm22Course.start_time,
  schedule_relationship: 0,
  schedule_relationship_name: 'SCHEDULED',
  stop_time_updates: [
    {
      stop_id: 'TM0470',
      stop_sequence: tm22Course.stop_sequences[tm22Indexes[2]],
      arrival: { timestamp: tm22UpdateAt0470 }
    },
    {
      stop_sequence: tm22Course.stop_sequences[tm22Indexes[3]],
      arrival: { timestamp: tm22UpdateAt2023 }
    }
  ]
};
const tm22BoardAt2086 = actual.buildBoard({
  routes: [], skipped_trips: [], realtime_trips: [tm22RealtimeTrip]
}, '2086', tm22NowBefore2086);
const tm22FallbackAt2086 = tm22BoardAt2086.routes
  .filter(route => route.route_id === 'TM22')
  .flatMap(route => route.times);
assert.ok(
  tm22FallbackAt2086.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-11-16T05:20:00+02:00') / 1000)),
  'tram 22 at 2086 must keep its GTFS fallback when the first realtime update is only at the later stop 0470'
);
assert.ok(
  tm22FallbackAt2086.some(time => time.scheduled && time.timestamp > Date.parse('2026-11-16T05:20:00+02:00') / 1000),
  'suppressing the partial realtime tram 22 course must preserve later scheduled courses'
);
const tm22BoardAt0470 = actual.buildBoard({
  routes: [], skipped_trips: [], realtime_trips: [tm22RealtimeTrip]
}, '0470', tm22NowBefore2086);
const tm22RealtimeAt0470 = tm22BoardAt0470.routes.find(route =>
  route.route_id === 'TM22' && route.times.some(time => !time.scheduled && Math.round(time.timestamp) === Math.round(tm22UpdateAt0470))
);
assert.ok(tm22RealtimeAt0470, 'tram 22 at 0470 must use the provided realtime prediction');
assert.ok(
  tm22RealtimeAt0470.times.some(time => !time.scheduled && time.trip_id === tm22Course.original_trip_id
    && time.trip_start_time === tm22Course.start_time),
  'realtime arrivals must retain the same exact trip identity as their GTFS fallback'
);
assert.equal(tm22RealtimeAt0470.terminal_stop_id, '2023', 'the destination must remain the full GTFS terminal, not the last partial realtime update');
assert.equal(tm22RealtimeAt0470.destination, 'Автостанция Изток', 'the full-course destination must resolve to the terminal stop name');
const tm22BoardAt0633 = actual.buildBoard({
  routes: [], skipped_trips: [], realtime_trips: [tm22RealtimeTrip]
}, '0633', new Date('2026-11-16T05:04:00+02:00'));
assert.ok(
  tm22BoardAt0633.routes.some(route => route.route_id === 'TM22'
    && route.times.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-11-16T05:06:00+02:00') / 1000))),
  'tram 22 at 0633 must keep its GTFS fallback because later realtime updates cannot be propagated backwards'
);

// Regression for stop 1411 / bus 190: the 12:27 course reaches the selected
// stop at 12:33. An update at the following stop is partial realtime data for
// this exact course, so its earlier GTFS fallback must also be suppressed.
const actual190Route = actualRoutes.find(route => route.route_id === 'A277');
assert.ok(actual190Route, 'the production data must contain bus 190');
const actual190Direction = Object.entries(actualDirections.A277 || {}).find(([directionKey, direction]) =>
  Array.isArray(direction.pattern)
  && direction.pattern.map(String).includes('1411')
  && (actualSchedules.A277?.[directionKey]?.weekday || []).some(row => row.start_time === '12:27:00')
);
assert.ok(actual190Direction, 'bus 190 must have a weekday direction serving stop 1411');
const [actual190DirectionKey, actual190DirectionData] = actual190Direction;
const actual190StopIndex = actual190DirectionData.pattern.map(String).indexOf('1411');
const actual190Course = actualSchedules.A277[actual190DirectionKey].weekday.find(row => row.start_time === '12:27:00');
assert.equal(actual190Course.times[actual190StopIndex], '12:33:00');
const actual190Now = new Date('2026-11-16T12:15:00+02:00');
const actual190ScheduledTimestamp = Date.parse('2026-11-16T12:33:00+02:00') / 1000;
const actual190NextStopIndex = actual190StopIndex + 1;
const actual190LaterStopTime = actual190Course.times[actual190NextStopIndex];
const actual190LaterStopTimestamp = Date.parse(`2026-11-16T${actual190LaterStopTime}+02:00`) / 1000;
const actual190BoardWithLaterStopOnly = actual.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: actual190Course.original_trip_id,
    route_id: 'A277',
    trip_start_date: '20261116',
    trip_start_time: actual190Course.start_time,
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    stop_time_updates: [{
      stop_sequence: actual190Course.stop_sequences[actual190NextStopIndex],
      arrival: { timestamp: actual190LaterStopTimestamp }
    }]
  }]
}, '1411', actual190Now);
const actual190StaticTimes = actual190BoardWithLaterStopOnly.routes
  .filter(route => route.route_id === 'A277')
  .flatMap(route => route.times);
assert.ok(
  actual190StaticTimes.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(actual190ScheduledTimestamp)),
  'the 12:33 bus 190 fallback must remain when realtime data covers only the following stop'
);
assert.ok(
  actual190StaticTimes.some(time => time.scheduled && time.timestamp > actual190ScheduledTimestamp),
  'suppressing the partial realtime bus 190 course must leave later courses available from the timetable'
);

// A time-only update at the first stop is enough to infer a downstream arrival
// before the vehicle reaches stop 1411. This is the path affected when the
// protobuf uncertainty field was previously decoded as scheduled_time.
const actual190OriginIndex = 0;
const actual190OriginScheduledTimestamp = Date.parse(`2026-11-16T${actual190Course.times[actual190OriginIndex]}+02:00`) / 1000;
const actual190OriginEventTimestamp = actual190OriginScheduledTimestamp + 30;
const actual190BoardWithOriginPrediction = actual.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: actual190Course.original_trip_id,
    route_id: 'A277',
    trip_start_date: '20261116',
    trip_start_time: actual190Course.start_time,
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    stop_time_updates: [{
      stop_sequence: actual190Course.stop_sequences[actual190OriginIndex],
      departure: {
        timestamp: actual190OriginEventTimestamp,
        uncertainty: 30
      }
    }]
  }]
}, '1411', actual190Now);
const actual190RealtimeRow = actual190BoardWithOriginPrediction.routes.find(route =>
  route.route_id === 'A277'
  && route.times.some(time => !time.scheduled
    && Math.round(time.timestamp) === Math.round(actual190ScheduledTimestamp + 30))
);
assert.ok(
  actual190RealtimeRow,
  'bus 190 must show a realtime prediction at stop 1411 from a time-only update at the origin'
);


// TripUpdate.timestamp records the latest measured vehicle progress. It must
// not discard an otherwise valid future absolute StopTimeEvent.time simply
// because that measurement is older than the application's relative-delay
// freshness threshold.
const fiveMinutesAgo = Math.floor(now.getTime() / 1000) - 5 * 60;
const staleMeasurementAbsoluteTimeBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A', route_id: 'TB7', trip_start_date: '20261030',
    trip_start_time: '13:00:00', direction_id: 'D1', schedule_relationship: 0,
    trip_update_timestamp: fiveMinutesAgo,
    stop_time_updates: [{
      stop_id: 'BOARD', stop_sequence: 2, schedule_relationship: 0,
      arrival: { timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000 }
    }]
  }]
}, '0200', now);
const staleMeasurementAbsoluteTime = staleMeasurementAbsoluteTimeBoard.routes
  .flatMap(route => route.times)
  .find(time => time.source === 'realtime' && time.trip_id === 'GTFS-TRIP-A');
assert.equal(staleMeasurementAbsoluteTime?.timestamp, Date.parse('2026-10-30T13:42:00+02:00') / 1000,
  'an absolute future StopTimeEvent.time remains usable with an older TripUpdate.timestamp');

// Delay-only estimates depend on the timestamp of the last measured progress.
// When that measurement is stale, do not extrapolate the old delay; keep GTFS.
const staleMeasurementDelayOnlyBoard = service.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'GTFS-TRIP-A', route_id: 'TB7', trip_start_date: '20261030',
    trip_start_time: '13:00:00', direction_id: 'D1', schedule_relationship: 0,
    trip_update_timestamp: fiveMinutesAgo,
    stop_time_updates: [{
      stop_id: 'BOARD', stop_sequence: 2, schedule_relationship: 0,
      arrival: { delay: 120 }
    }]
  }]
}, '0200', now);
const staleDelayTimes = staleMeasurementDelayOnlyBoard.routes
  .flatMap(route => route.times);
assert.ok(staleDelayTimes.some(time => time.scheduled && time.trip_id === 'GTFS-TRIP-A'),
  'a stale delay-only update must retain the scheduled GTFS fallback');
assert.ok(!staleDelayTimes.some(time => time.source === 'realtime' && time.trip_id === 'GTFS-TRIP-A'),
  'a stale delay-only update must not be presented as realtime');

console.log('virtual-board-service: all tests passed');
