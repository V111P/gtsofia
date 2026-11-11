const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'virtual-boards.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const localStorageData = new Map();
const context = {
  console,
  Math,
  Intl,
  URLSearchParams,
  localStorage: {
    getItem: key => localStorageData.get(key) || '[]',
    setItem: (key, value) => localStorageData.set(key, value)
  },
  document: { addEventListener() {} },
  window: {},
  Date
};
context.globalThis = context;

vm.runInNewContext(source, context, { filename: sourcePath });
const {
  formatArrivalCountdown,
  rememberRealtimeArrivalPredictions,
  reconcileRealtimeCoursePresence,
  suppressPassedRealtimeFallbacks,
  sameArrivalTrip,
  sortBoardRoutesByNextArrival,
  getBoardAutoRefreshDelay,
  recordBoardRefreshOutcome
} = context.__gtsofiaVirtualBoardTestInternals;

const now = 1_000;
const cases = [
  [60, '1 мин.', 'exactly 60 seconds remaining'],
  [60.001, '1 мин.', 'a little over one minute remaining'],
  [59.999, '1 мин.', 'just under one minute remaining'],
  [59.9, '1 мин.', '59.9 seconds remaining'],
  [29.9, '0 мин.', 'less than 30 seconds remaining'],
  [30, '1 мин.', 'exactly 30 seconds remaining'],
  [0, '0 мин.', 'at the arrival timestamp'],
  [119, '2 мин.', '1 minute 59 seconds remaining'],
  [120, '2 мин.', 'exactly two minutes remaining'],
  [89.9, '1 мин.', '1 minute 29.9 seconds remaining'],
  [90, '2 мин.', '1 minute 30 seconds remaining'],
  [-30, '0 мин.', 'an arrival that has already passed'],
  [149.9, '2 мин.', '2 minutes 29.9 seconds remaining'],
  [150, '3 мин.', '2 minutes 30 seconds remaining'],
  [179, '3 мин.', '2 minutes 59 seconds remaining'],
  [541, '9 мин.', '9 minutes 1 second remaining'],
  [569, '9 мин.', '9 minutes 29 seconds remaining'],
  [570, '10 мин.', '9 minutes 30 seconds remaining']
];

for (const [offset, expected, label] of cases) {
  assert.equal(
    formatArrivalCountdown(now + offset, now),
    expected,
    `${label} should round to ${expected}`
  );
}

assert.equal(formatArrivalCountdown('not-a-timestamp', now), '', 'invalid timestamps should render as an empty label');
assert.equal(
  formatArrivalCountdown(now + 541, now),
  formatArrivalCountdown(now + 541, now),
  'the same arrival must keep the same displayed minutes while the board snapshot timestamp is unchanged'
);
assert.doesNotMatch(source, /\bsetInterval\s*\(/, 'auto refresh must use a single chained timeout, never overlapping intervals');
assert.doesNotMatch(source, /updateBoardCountdowns|startTimers|data-arrival-timestamp/, 'continuous per-second countdown timers must remain removed');
assert.match(source, /BOARD_AUTO_REFRESH_INTERVAL_MS = 30_000/, 'normal auto refresh must use a restrained 30-second interval');
assert.match(source, /BOARD_AUTO_REFRESH_STATIC_INTERVAL_MS = 60_000/, 'schedule-only metro boards must refresh less frequently');
assert.match(source, /BOARD_AUTO_REFRESH_MAX_INTERVAL_MS = 120_000/, 'repeated failures must back off to at most 2 minutes');
assert.match(source, /document\.visibilityState === 'hidden'/, 'auto refresh must pause while the browser tab is hidden');
assert.match(source, /scheduleBoardAutoRefresh\(\)/, 'the next refresh must be scheduled only after the previous request finishes');
assert.doesNotMatch(source, /Обновено:|Последно успешно зареждане:|Обновено в/, 'the last-updated text must not be rendered');
assert.doesNotMatch(source, /За метрото се използва разписанието|По разписание/, 'the explanatory metro schedule label must remain hidden');

assert.equal(getBoardAutoRefreshDelay(), 30_000, 'a healthy realtime board should refresh every 30 seconds');
recordBoardRefreshOutcome(null, new Error('temporary network failure'));
assert.equal(getBoardAutoRefreshDelay(), 60_000, 'the first failure should back off to 60 seconds');
recordBoardRefreshOutcome(null, new Error('second network failure'));
assert.equal(getBoardAutoRefreshDelay(), 120_000, 'repeated failures should back off to 120 seconds');
recordBoardRefreshOutcome(null, new Error('third network failure'));
assert.equal(getBoardAutoRefreshDelay(), 120_000, 'the backoff must be capped at 120 seconds');
recordBoardRefreshOutcome({ realtime_status: 'available' });
assert.equal(getBoardAutoRefreshDelay(), 30_000, 'a successful realtime response should reset the interval');
recordBoardRefreshOutcome({ realtime_status: 'unavailable' });
assert.equal(getBoardAutoRefreshDelay(), 60_000, 'a GTFS fallback response caused by unavailable realtime should back off');
recordBoardRefreshOutcome({ realtime_status: 'not_applicable' });
assert.equal(getBoardAutoRefreshDelay(), 60_000, 'metro should use a 60-second schedule-only refresh interval');

// A v1 history entry may contain the producer Trip ID while a refreshed
// response contains the canonical GTFS Trip ID. Match the two only when the
// exact planned passage timestamp at this stop also agrees.
const stopId = '0470';
const previousRealtimeSnapshot = {
  routes: [{
    route_id: 'TM22',
    // Simulate a v1 browser history record created before the API began
    // normalizing producer Trip IDs to the canonical GTFS original_trip_id.
    trip_id: 'PRODUCER-TRIP-42',
    trip_start_date: '20261110',
    trip_start_time: '14:00:00',
    direction_id: '2',
    realtime: true,
    times: [{
      timestamp: 14 * 3600 + 39 * 60,
      scheduled_time: 14 * 3600 + 42 * 60,
      scheduled: false,
      source: 'realtime',
      route_id: 'TM22',
      trip_id: 'PRODUCER-TRIP-42',
      trip_start_date: '20261110',
      trip_start_time: '14:00:00',
      direction_id: '2'
    }]
  }]
};
const beforeArrival = 14 * 3600 + 38 * 60;
const intermediateRefresh = 14 * 3600 + 38 * 60 + 30;
const afterArrival = 14 * 3600 + 40 * 60;
rememberRealtimeArrivalPredictions(previousRealtimeSnapshot, stopId, beforeArrival);

// A later feed refresh may revise the ETA from 14:39 to 14:41 just before
// the earlier estimate elapses, while also switching to the canonical GTFS ID
// and a different direction_id encoding. Keep the earliest observed estimate
// so the old GTFS 14:42 time cannot resurrect the same early-running vehicle.
const revisedRealtimeSnapshot = {
  routes: [{
    route_id: 'TM22',
    trip_id: 'TM22-TRIP-42',
    realtime_trip_id: 'PRODUCER-TRIP-42',
    trip_start_date: '20261110',
    trip_start_time: '14:00:00',
    direction_id: '0',
    realtime: true,
    times: [{
      timestamp: 14 * 3600 + 41 * 60,
      scheduled_time: 14 * 3600 + 42 * 60,
      scheduled: false,
      source: 'realtime',
      route_id: 'TM22',
      trip_id: 'TM22-TRIP-42',
      realtime_trip_id: 'PRODUCER-TRIP-42',
      trip_start_date: '20261110',
      trip_start_time: '14:00:00',
      direction_id: '0'
    }]
  }]
};
rememberRealtimeArrivalPredictions(revisedRealtimeSnapshot, stopId, intermediateRefresh);

assert.equal(
  sameArrivalTrip(
    { stop_id: stopId, route_id: 'TM22', trip_id: 'TM22-TRIP-42', trip_start_date: '20261110', trip_start_time: '14:00:00', direction_id: '2' },
    { stop_id: stopId, route_id: 'TM22', trip_id: 'TM22-TRIP-42', trip_start_date: '20261110', trip_start_time: '14:00:00', direction_id: '0' }
  ),
  true,
  'matching GTFS Trip ID and start time must survive inconsistent direction_id values'
);

assert.equal(
  sameArrivalTrip(
    { stop_id: stopId, route_id: 'TM22', trip_id: 'TM22-TRIP-42', realtime_trip_id: 'PRODUCER-TRIP-42', trip_start_date: '20261110', trip_start_time: '14:00:00', direction_id: '2' },
    { stop_id: stopId, route_id: 'TM22', trip_id: 'PRODUCER-TRIP-42', trip_start_date: '20261110', trip_start_time: '14:00:00', direction_id: '2' }
  ),
  true,
  'a previous canonical history record must recognize the producer ID alias when the descriptor remains in the feed'
);

assert.equal(
  sameArrivalTrip(
    { stop_id: stopId, route_id: 'TM22', trip_id: 'OLD-PRODUCER-ID', trip_start_date: '20261110', trip_start_time: '14:00:00', direction_id: '0', scheduled_time: 14 * 3600 + 42 * 60 },
    { stop_id: stopId, route_id: 'TM22', trip_id: 'NEW-GTFS-ID', trip_start_date: '20261110', trip_start_time: '14:00:00', direction_id: '1', scheduled_time: 14 * 3600 + 42 * 60 }
  ),
  false,
  'a scheduled-time alias must not merge conflicting Trip IDs from opposite directions'
);

const refreshedTimetableSnapshot = {
  status: 'ok',
  routes: [{
    route_id: 'TM22',
    destination: 'Автостанция Изток',
    times: [
      {
        timestamp: 14 * 3600 + 42 * 60,
        scheduled: true,
        source: 'static',
        route_id: 'TM22',
        trip_id: 'TM22-TRIP-42',
        trip_start_date: '20261110',
        trip_start_time: '14:00:00',
        direction_id: '2'
      },
      {
        timestamp: 14 * 3600 + 50 * 60,
        scheduled: true,
        source: 'static',
        route_id: 'TM22',
        trip_id: 'TM22-TRIP-50',
        trip_start_date: '20261110',
        trip_start_time: '14:10:00',
        direction_id: '2'
      },
      {
        timestamp: 14 * 3600 + 45 * 60,
        scheduled: true,
        source: 'static',
        route_id: 'TM22',
        trip_id: 'TM22-TRIP-42',
        trip_start_date: '20261110',
        trip_start_time: '14:05:00',
        direction_id: '2'
      }
    ]
  }]
};
const refreshedAfterVehiclePassed = suppressPassedRealtimeFallbacks(
  refreshedTimetableSnapshot,
  stopId,
  afterArrival
);
assert.equal(refreshedAfterVehiclePassed.routes.length, 1, 'the line must remain visible after removing the passed trip');
assert.deepEqual(
  refreshedAfterVehiclePassed.routes[0].times.map(time => time.trip_start_time).sort(),
  ['14:05:00', '14:10:00'],
  'a passed realtime trip must not return with its later GTFS time; a separate instance of the same trip template and the next course must remain'
);

const beforeRealtimeArrival = suppressPassedRealtimeFallbacks(
  refreshedTimetableSnapshot,
  stopId,
  beforeArrival
);
assert.deepEqual(
  beforeRealtimeArrival.routes[0].times.map(time => time.trip_start_time).sort(),
  ['14:00:00', '14:05:00', '14:10:00'],
  'a remembered realtime prediction must not suppress its GTFS fallback before its predicted arrival'
);

// An early-running vehicle can disappear from a fresh feed before its last
// predicted ETA. Waiting until that ETA elapses is too late: its later GTFS
// time would briefly reappear. A stop-independent descriptor list distinguishes
// a vanished course from a trip that remains in the feed but has no update for
// this particular stop.
const earlyRunStopId = 'EARLY-RUN-STOP';
const earlyRunAt = 14 * 3600 + 38 * 60;
const earlyRunNextPoll = earlyRunAt + 30;
const earlyRunCourse = {
  route_id: 'TB42',
  trip_id: 'GTFS-TRIP-42',
  realtime_trip_id: 'PRODUCER-TRIP-42',
  trip_start_date: '20261110',
  trip_start_time: '14:00:00',
  direction_id: 'D1'
};
const earlyRunRealtimeBoard = {
  realtime_status: 'available',
  realtime_feed_timestamp: earlyRunAt,
  routes: [{
    route_id: 'TB42',
    trip_id: 'GTFS-TRIP-42',
    realtime_trip_id: 'PRODUCER-TRIP-42',
    trip_start_date: '20261110',
    trip_start_time: '14:00:00',
    direction_id: 'D1',
    realtime: true,
    times: [{
      timestamp: 14 * 3600 + 39 * 60,
      scheduled_time: 14 * 3600 + 42 * 60,
      scheduled: false,
      source: 'realtime',
      route_id: 'TB42',
      trip_id: 'GTFS-TRIP-42',
      realtime_trip_id: 'PRODUCER-TRIP-42',
      trip_start_date: '20261110',
      trip_start_time: '14:00:00',
      direction_id: 'D1'
    }]
  }]
};
rememberRealtimeArrivalPredictions(earlyRunRealtimeBoard, earlyRunStopId, earlyRunAt);
assert.equal(reconcileRealtimeCoursePresence({
  ...earlyRunRealtimeBoard,
  realtime_courses: [earlyRunCourse]
}, earlyRunStopId, earlyRunAt), false,
'a course still present in the fresh feed must not be marked as disappeared');

const earlyRunFallbackBoard = {
  realtime_status: 'available',
  realtime_feed_timestamp: earlyRunNextPoll,
  realtime_courses: [{
    ...earlyRunCourse,
    stop_update_state: 'downstream-only'
  }],
  routes: [{
    route_id: 'TB42',
    times: [
      {
        timestamp: 14 * 3600 + 42 * 60,
        scheduled: true,
        source: 'static',
        route_id: 'TB42',
        trip_id: 'GTFS-TRIP-42',
        trip_start_date: '20261110',
        trip_start_time: '14:00:00',
        direction_id: 'D1'
      },
      {
        timestamp: 14 * 3600 + 50 * 60,
        scheduled: true,
        source: 'static',
        route_id: 'TB42',
        trip_id: 'GTFS-TRIP-50',
        trip_start_date: '20261110',
        trip_start_time: '14:10:00',
        direction_id: 'D1'
      }
    ]
  }]
};
assert.equal(reconcileRealtimeCoursePresence(earlyRunFallbackBoard, earlyRunStopId, earlyRunNextPoll), true,
'a course whose fresh TripUpdate has advanced to downstream stops must be retired before its predicted ETA if necessary');
const earlyRunSuppressed = suppressPassedRealtimeFallbacks(
  earlyRunFallbackBoard,
  earlyRunStopId,
  earlyRunNextPoll
);
assert.deepEqual(
  earlyRunSuppressed.routes.flatMap(route => route.times).map(time => time.trip_start_time),
  ['14:10:00'],
  'a vanished early-running course must not reappear at its later GTFS time; the next distinct run must remain'
);

const disappearedStopId = 'DISAPPEARED-COURSE-STOP';
rememberRealtimeArrivalPredictions(earlyRunRealtimeBoard, disappearedStopId, earlyRunAt);
const disappearedCourseSnapshot = {
  realtime_status: 'available',
  realtime_feed_timestamp: earlyRunNextPoll,
  realtime_courses: [],
  routes: [{
    route_id: 'TB42',
    times: [{
      timestamp: 14 * 3600 + 42 * 60,
      scheduled: true,
      trip_id: 'GTFS-TRIP-42',
      realtime_trip_id: 'PRODUCER-TRIP-42',
      trip_start_date: '20261110',
      trip_start_time: '14:00:00',
      direction_id: 'D1'
    }]
  }]
};
assert.equal(reconcileRealtimeCoursePresence(disappearedCourseSnapshot, disappearedStopId, earlyRunNextPoll), true,
'a course removed completely from a fresh valid feed must also be retired');
assert.equal(suppressPassedRealtimeFallbacks(disappearedCourseSnapshot, disappearedStopId, earlyRunNextPoll)
  .routes.flatMap(route => route.times).length, 0,
'a completely disappeared realtime course must not be resurrected by its later timetable time');

// A descriptor still present in the feed is not considered gone merely
// because it has no prediction for this stop (e.g. its updates cover a later
// route segment only). In that case the per-stop GTFS fallback remains valid.
const partialCoverageStopId = 'PARTIAL-COVERAGE-STOP';
const partialCoverageAt = 14 * 3600 + 38 * 60;
rememberRealtimeArrivalPredictions({
  routes: [{
    route_id: 'TB42', trip_id: 'GTFS-PARTIAL', realtime_trip_id: 'PRODUCER-PARTIAL',
    trip_start_date: '20261110', trip_start_time: '14:00:00', direction_id: 'D1', realtime: true,
    times: [{
      timestamp: 14 * 3600 + 39 * 60, scheduled_time: 14 * 3600 + 42 * 60,
      scheduled: false, source: 'realtime', trip_id: 'GTFS-PARTIAL',
      realtime_trip_id: 'PRODUCER-PARTIAL', trip_start_date: '20261110',
      trip_start_time: '14:00:00', direction_id: 'D1'
    }]
  }]
}, partialCoverageStopId, partialCoverageAt);
const partialCoverageSnapshot = {
  realtime_status: 'available',
  realtime_feed_timestamp: partialCoverageAt + 20,
  realtime_courses: [{
    route_id: 'TB42', trip_id: 'GTFS-PARTIAL', realtime_trip_id: 'PRODUCER-PARTIAL',
    trip_start_date: '20261110', trip_start_time: '14:00:00', direction_id: 'D1'
  }],
  routes: [{
    route_id: 'TB42',
    times: [{
      timestamp: 14 * 3600 + 42 * 60, scheduled: true, trip_id: 'GTFS-PARTIAL',
      trip_start_date: '20261110', trip_start_time: '14:00:00', direction_id: 'D1'
    }]
  }]
};
assert.equal(reconcileRealtimeCoursePresence(partialCoverageSnapshot, partialCoverageStopId, partialCoverageAt + 20), false,
'a realtime descriptor still present in the current feed must not be retired due to a local stop coverage gap');
assert.equal(suppressPassedRealtimeFallbacks(partialCoverageSnapshot, partialCoverageStopId, partialCoverageAt + 20)
  .routes.flatMap(route => route.times).length, 1,
'GTFS fallback must remain visible when the descriptor still exists but has no usable stop prediction');

const noDataStopId = 'NO-DATA-STOP';
rememberRealtimeArrivalPredictions({
  routes: [{
    route_id: 'TB42', trip_id: 'GTFS-NO-DATA', trip_start_date: '20261110',
    trip_start_time: '14:00:00', direction_id: 'D1', realtime: true,
    times: [{ timestamp: 14 * 3600 + 39 * 60, scheduled_time: 14 * 3600 + 42 * 60,
      scheduled: false, source: 'realtime', trip_id: 'GTFS-NO-DATA',
      trip_start_date: '20261110', trip_start_time: '14:00:00', direction_id: 'D1' }]
  }]
}, noDataStopId, partialCoverageAt);
const noDataSnapshot = {
  realtime_status: 'available',
  realtime_feed_timestamp: partialCoverageAt + 20,
  realtime_courses: [{
    route_id: 'TB42', trip_id: 'GTFS-NO-DATA', trip_start_date: '20261110',
    trip_start_time: '14:00:00', direction_id: 'D1', stop_update_state: 'no-data'
  }],
  routes: [{
    route_id: 'TB42',
    times: [{ timestamp: 14 * 3600 + 42 * 60, scheduled: true,
      trip_id: 'GTFS-NO-DATA', trip_start_date: '20261110',
      trip_start_time: '14:00:00', direction_id: 'D1' }]
  }]
};
assert.equal(reconcileRealtimeCoursePresence(noDataSnapshot, noDataStopId, partialCoverageAt + 20), false,
'explicit NO_DATA at the selected stop is a local coverage gap, not proof that the vehicle passed');
assert.equal(suppressPassedRealtimeFallbacks(noDataSnapshot, noDataStopId, partialCoverageAt + 20)
  .routes.flatMap(route => route.times).length, 1,
'GTFS fallback must remain available for an explicit NO_DATA update at the selected stop');

// A failed upstream request is not evidence that a vehicle disappeared from
// the feed. Retain the ordinary GTFS fallback in that case.
const outageStopId = 'REALTIME-OUTAGE-STOP';
rememberRealtimeArrivalPredictions({
  routes: [{
    route_id: 'TB42', trip_id: 'GTFS-OUTAGE', trip_start_date: '20261110',
    trip_start_time: '14:00:00', direction_id: 'D1', realtime: true,
    times: [{ timestamp: 14 * 3600 + 39 * 60, scheduled: false, source: 'realtime',
      trip_id: 'GTFS-OUTAGE', trip_start_date: '20261110', trip_start_time: '14:00:00', direction_id: 'D1' }]
  }]
}, outageStopId, partialCoverageAt);
const outageFallbackSnapshot = {
  realtime_status: 'unavailable',
  realtime_courses: [],
  routes: [{
    route_id: 'TB42',
    times: [{ timestamp: 14 * 3600 + 42 * 60, scheduled: true, trip_id: 'GTFS-OUTAGE',
      trip_start_date: '20261110', trip_start_time: '14:00:00', direction_id: 'D1' }]
  }]
};
assert.equal(reconcileRealtimeCoursePresence(outageFallbackSnapshot, outageStopId, partialCoverageAt + 20), false,
'a realtime outage must not mark previously observed trips as missing');
assert.equal(suppressPassedRealtimeFallbacks(outageFallbackSnapshot, outageStopId, partialCoverageAt + 20)
  .routes.flatMap(route => route.times).length, 1,
'GTFS fallback must remain available when the realtime API itself is unavailable');

const staleFeedSnapshot = {
  realtime_status: 'available',
  realtime_feed_timestamp: partialCoverageAt - 180,
  realtime_courses: [],
  routes: []
};
assert.equal(reconcileRealtimeCoursePresence(staleFeedSnapshot, outageStopId, partialCoverageAt + 20), false,
'a stale feed timestamp must not be treated as proof that a previously observed course disappeared');

// v1 localStorage records did not persist scheduled_time. The fallback must
// still match them when the service date, exact start time and direction agree.
const legacyHistoryKey = 'gtsofia.virtualBoard.realtimeArrivalHistory.v1';
localStorageData.set(legacyHistoryKey, JSON.stringify([{
  identity: {
    stop_id: 'LEGACY-STOP',
    route_id: 'TB42',
    trip_id: 'OLD-PRODUCER-ID',
    trip_start_date: '20261110',
    trip_start_time: '14:00:00',
    direction_id: '2'
  },
  timestamp: 14 * 3600 + 39 * 60,
  earliest_timestamp: 14 * 3600 + 39 * 60,
  passed_at: 14 * 3600 + 39 * 60,
  remembered_at: 14 * 3600 + 38 * 60
}]));
const legacyIdentitySuppression = suppressPassedRealtimeFallbacks({
  status: 'ok',
  routes: [{
    route_id: 'TB42',
    times: [{
      timestamp: 14 * 3600 + 42 * 60,
      scheduled: true,
      route_id: 'TB42',
      trip_id: 'CANONICAL-GTFS-ID',
      trip_start_date: '20261110',
      trip_start_time: '14:00:00',
      direction_id: '2'
    }]
  }]
}, 'LEGACY-STOP', 14 * 3600 + 40 * 60);
assert.equal(legacyIdentitySuppression.routes.length, 0,
  'legacy producer IDs must still suppress the same GTFS course when the exact service/start/direction signature matches');

// Client-side suppression can remove the first scheduled arrival in a line
// group after the API has already sorted the groups. The groups must then be
// sorted again by their new earliest remaining arrival.
const mixedLineSnapshot = {
  status: 'ok',
  routes: [
    {
      route_id: 'TM22',
      route_ref: '22',
      destination: 'Автостанция Изток',
      times: [
        {
          timestamp: 14 * 3600 + 42 * 60,
          scheduled: true,
          route_id: 'TM22',
          trip_id: 'TM22-TRIP-42',
          trip_start_date: '20261110',
          trip_start_time: '14:00:00',
          direction_id: '2'
        },
        {
          timestamp: 14 * 3600 + 50 * 60,
          scheduled: true,
          route_id: 'TM22',
          trip_id: 'TM22-TRIP-50',
          trip_start_date: '20261110',
          trip_start_time: '14:10:00',
          direction_id: '2'
        }
      ]
    },
    {
      route_id: 'TB1',
      route_ref: '1',
      destination: 'Друг маршрут',
      times: [{ timestamp: 14 * 3600 + 45 * 60, scheduled: true }]
    }
  ]
};
const resortedAfterSuppression = suppressPassedRealtimeFallbacks(
  mixedLineSnapshot,
  stopId,
  afterArrival
);
assert.deepEqual(
  resortedAfterSuppression.routes.map(route => route.route_id),
  ['TB1', 'TM22'],
  'after removing a passed early course, the route with the next earliest arrival must move above it'
);
assert.deepEqual(
  sortBoardRoutesByNextArrival([
    { route_id: 'TB1', route_ref: '1', times: [{ timestamp: now + 360 }] },
    { route_id: 'TB7', route_ref: '7', times: [{ timestamp: now + 60 }] }
  ]).map(route => route.route_id),
  ['TB7', 'TB1'],
  'all line groups must be globally ordered by their next arrival timestamp, independent of input order'
);

// End-to-end regression: first refresh shows an early realtime arrival;
// the next fresh feed still contains the course but only reports a downstream
// stop. The course must not return from GTFS with its later scheduled time.
const { createDataContext } = require('../api/virtual-board-service');
const integrationDate = '2026-10-30';
const integrationStart = new Date('2026-10-30T14:38:00+02:00');
const integrationStopId = 'BOARD-EARLY-INTEGRATION';
const integrationService = createDataContext({
  routes: [{ route_id: 'TB42', route_short_name: '42', route_type: '3' }],
  directions: {
    TB42: {
      D1: {
        key: 'D1', direction_id: 'D1', headsign: 'Крайна спирка', destination: 'Крайна спирка',
        pattern: ['START-EARLY', integrationStopId, 'END-EARLY'],
        stops: [
          { stop_id: 'START-EARLY', osm_name: 'Начало' },
          { stop_id: integrationStopId, osm_name: 'Тестова спирка' },
          { stop_id: 'END-EARLY', osm_name: 'Крайна спирка' }
        ]
      }
    }
  },
  schedules: {
    TB42: {
      D1: {
        weekday: [
          { trip_id: 42, original_trip_id: 'GTFS-EARLY-42', service_id: 'SERVICE', start_time: '14:00:00', stop_sequences: [1, 2, 3], times: ['14:00:00', '14:42:00', '15:03:00'] },
          { trip_id: 43, original_trip_id: 'GTFS-NEXT-43', service_id: 'SERVICE', start_time: '14:10:00', stop_sequences: [1, 2, 3], times: ['14:10:00', '14:50:00', '15:11:00'] }
        ],
        weekend: []
      }
    }
  },
  stops: [
    { stop_id: integrationStopId, stop_code: 'EARLY42', stop_name: 'Тестова спирка', osm_stop_name: 'Тестова спирка' },
    { stop_id: 'START-EARLY', stop_code: 'START-EARLY', stop_name: 'Начало' },
    { stop_id: 'END-EARLY', stop_code: 'END-EARLY', stop_name: 'Крайна спирка' }
  ],
  calendar: {
    dateTypes: { [integrationDate]: 'weekday' },
    serviceIdsByDate: { [integrationDate]: ['SERVICE'] }
  }
});

const firstIntegrationFeed = integrationService.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'PRODUCER-EARLY-42', route_id: 'TB42', trip_start_date: '20261030',
    trip_start_time: '14:00:00', direction_id: 'D1',
    schedule_relationship: 0, schedule_relationship_name: 'SCHEDULED',
    stop_time_updates: [{
      stop_id: integrationStopId, stop_sequence: 2, schedule_relationship: 0,
      arrival: {
        timestamp: Date.parse('2026-10-30T14:39:00+02:00') / 1000,
        scheduled_time: Date.parse('2026-10-30T14:42:00+02:00') / 1000,
        delay: -180
      }
    }]
  }]
}, 'EARLY42', integrationStart);
assert.ok(firstIntegrationFeed.routes.some(route => route.times.some(time => time.source === 'realtime')),
  'the first integration refresh must show the early realtime arrival');
assert.equal(firstIntegrationFeed.realtime_courses[0]?.stop_update_state, 'target-update',
  'the first feed must classify this course as having a realtime update at the selected stop');
const firstIntegrationSnapshot = {
  ...firstIntegrationFeed,
  realtime_status: 'available',
  realtime_feed_timestamp: Math.floor(integrationStart.getTime() / 1000)
};
rememberRealtimeArrivalPredictions(firstIntegrationSnapshot, integrationStopId, integrationStart.getTime() / 1000);
reconcileRealtimeCoursePresence(firstIntegrationSnapshot, integrationStopId, integrationStart.getTime() / 1000);

const secondIntegrationNow = new Date('2026-10-30T14:38:30+02:00');
const secondIntegrationFeed = integrationService.buildBoard({
  routes: [],
  skipped_trips: [],
  realtime_trips: [{
    trip_id: 'PRODUCER-EARLY-42', route_id: 'TB42', trip_start_date: '20261030',
    trip_start_time: '14:00:00', direction_id: 'D1',
    schedule_relationship: 0, schedule_relationship_name: 'SCHEDULED',
    stop_time_updates: [{
      stop_id: 'END-EARLY', stop_sequence: 3, schedule_relationship: 0,
      arrival: {
        timestamp: Date.parse('2026-10-30T15:04:00+02:00') / 1000,
        scheduled_time: Date.parse('2026-10-30T15:03:00+02:00') / 1000,
        delay: 60
      }
    }]
  }]
}, 'EARLY42', secondIntegrationNow);
assert.equal(secondIntegrationFeed.realtime_courses[0]?.stop_update_state, 'downstream-only',
  'the second feed must show that the same course now has timed updates only downstream of the selected stop');
assert.ok(secondIntegrationFeed.routes.some(route => route.times.some(time => time.scheduled
  && time.trip_start_time === '14:00:00')),
  'the service layer should still generate the GTFS fallback before browser history reconciles the early course');
const secondIntegrationSnapshot = {
  ...secondIntegrationFeed,
  realtime_status: 'available',
  realtime_feed_timestamp: Math.floor(secondIntegrationNow.getTime() / 1000)
};
rememberRealtimeArrivalPredictions(secondIntegrationSnapshot, integrationStopId, secondIntegrationNow.getTime() / 1000);
reconcileRealtimeCoursePresence(secondIntegrationSnapshot, integrationStopId, secondIntegrationNow.getTime() / 1000);
const integratedEarlyArrivalResult = suppressPassedRealtimeFallbacks(
  secondIntegrationSnapshot,
  integrationStopId,
  secondIntegrationNow.getTime() / 1000
);
const integratedTimes = integratedEarlyArrivalResult.routes.flatMap(route => route.times);
assert.ok(!integratedTimes.some(time => time.scheduled && time.trip_start_time === '14:00:00'),
  'the early realtime course must not reappear as its later 14:42 GTFS fallback');
assert.ok(integratedTimes.some(time => time.scheduled && time.trip_start_time === '14:10:00'),
  'the next scheduled course must remain visible after suppressing the early-running course');

// Some GTFS-RT producers express an after-midnight course against the
// previous service day (24:10), while the static timetable/browser identity
// may express the same absolute stop event against the current day (00:10).
// The exact absolute scheduled passage at this stop must bridge that metadata
// difference, but not if the terminal/direction identifies another course.
const midnightScheduledStopTime = Date.parse('2026-11-11T00:10:00+02:00') / 1000;
assert.equal(
  sameArrivalTrip(
    { stop_id: 'MIDNIGHT-STOP', route_id: 'TB42', trip_id: 'OLD-RT-ID',
      trip_start_date: '20261110', trip_start_time: '24:10:00', direction_id: 'D1',
      terminal_stop_id: 'TERM-A', scheduled_time: midnightScheduledStopTime },
    { stop_id: 'MIDNIGHT-STOP', route_id: 'TB42', trip_id: 'NEW-GTFS-ID',
      trip_start_date: '20261111', trip_start_time: '00:10:00', direction_id: 'D1',
      terminal_stop_id: 'TERM-A', scheduled_time: midnightScheduledStopTime }
  ),
  true,
  'the same exact absolute stop event must match across different service-date/start-time encodings'
);
assert.equal(
  sameArrivalTrip(
    { stop_id: 'MIDNIGHT-STOP', route_id: 'TB42', trip_id: 'OLD-RT-ID',
      trip_start_date: '20261110', trip_start_time: '24:10:00', direction_id: 'D1',
      terminal_stop_id: 'TERM-A', scheduled_time: midnightScheduledStopTime },
    { stop_id: 'MIDNIGHT-STOP', route_id: 'TB42', trip_id: 'NEW-GTFS-ID',
      trip_start_date: '20261111', trip_start_time: '00:10:00', direction_id: 'D1',
      terminal_stop_id: 'TERM-B', scheduled_time: midnightScheduledStopTime }
  ),
  false,
  'an exact stop-time alias must not merge courses with different terminals'
);

const midnightRealtimeAt = Date.parse('2026-11-11T00:07:00+02:00') / 1000;
const midnightObservedEta = Date.parse('2026-11-11T00:08:00+02:00') / 1000;
const midnightRefreshAt = Date.parse('2026-11-11T00:09:00+02:00') / 1000;
rememberRealtimeArrivalPredictions({
  routes: [{
    route_id: 'TB42', trip_id: 'OLD-RT-ID', trip_start_date: '20261110',
    trip_start_time: '24:10:00', direction_id: 'D1', terminal_stop_id: 'TERM-A', realtime: true,
    times: [{ timestamp: midnightObservedEta, scheduled_time: midnightScheduledStopTime,
      scheduled: false, source: 'realtime', trip_id: 'OLD-RT-ID',
      trip_start_date: '20261110', trip_start_time: '24:10:00', direction_id: 'D1',
      terminal_stop_id: 'TERM-A' }]
  }]
}, 'MIDNIGHT-STOP', midnightRealtimeAt);
const midnightMissingSnapshot = {
  realtime_status: 'available',
  realtime_feed_timestamp: midnightRefreshAt,
  realtime_courses: [],
  routes: [{
    route_id: 'TB42',
    times: [{ timestamp: midnightScheduledStopTime, scheduled: true,
      source: 'static', trip_id: 'NEW-GTFS-ID', trip_start_date: '20261111',
      trip_start_time: '00:10:00', direction_id: 'D1', terminal_stop_id: 'TERM-A' }]
  }]
};
reconcileRealtimeCoursePresence(midnightMissingSnapshot, 'MIDNIGHT-STOP', midnightRefreshAt);
assert.equal(
  suppressPassedRealtimeFallbacks(midnightMissingSnapshot, 'MIDNIGHT-STOP', midnightRefreshAt).routes.length,
  0,
  'a previously observed realtime course must not resurrect as GTFS when service-date/start-time encoding changes across midnight'
);



// Once a fresh downstream-only TripUpdate has confirmed passage, a later
// stale/reappearing target update must not clear the passed state and allow
// the course to return through its GTFS fallback.
const stickyStopId = 'STICKY-PASSED-STOP';
const stickyFirstPoll = 14 * 3600 + 38 * 60;
const stickyCourse = {
  route_id: 'TB42', trip_id: 'GTFS-STICKY-42', realtime_trip_id: 'RT-STICKY-42',
  trip_start_date: '20261110', trip_start_time: '14:00:00', direction_id: 'D1'
};
rememberRealtimeArrivalPredictions({
  routes: [{
    ...stickyCourse,
    realtime: true,
    times: [{ timestamp: stickyFirstPoll + 60, scheduled_time: stickyFirstPoll + 240,
      scheduled: false, source: 'realtime', ...stickyCourse }]
  }]
}, stickyStopId, stickyFirstPoll);
const stickyDownstreamSnapshot = {
  realtime_status: 'available',
  realtime_feed_timestamp: stickyFirstPoll + 30,
  realtime_courses: [{ ...stickyCourse, stop_update_state: 'downstream-only' }],
  routes: []
};
assert.equal(reconcileRealtimeCoursePresence(stickyDownstreamSnapshot, stickyStopId, stickyFirstPoll + 30), true,
  'a downstream-only fresh update should confirm that the previously observed course passed the stop');

const staleReappearingRealtime = {
  realtime_status: 'available',
  realtime_feed_timestamp: stickyFirstPoll + 45,
  realtime_courses: [{ ...stickyCourse, stop_update_state: 'target-update' }],
  routes: [{
    ...stickyCourse,
    realtime: true,
    times: [{ timestamp: stickyFirstPoll + 90, scheduled_time: stickyFirstPoll + 240,
      scheduled: false, source: 'realtime', ...stickyCourse }]
  }]
};
rememberRealtimeArrivalPredictions(staleReappearingRealtime, stickyStopId, stickyFirstPoll + 45);
reconcileRealtimeCoursePresence(staleReappearingRealtime, stickyStopId, stickyFirstPoll + 45);
const stickyFallbackResult = suppressPassedRealtimeFallbacks({
  realtime_status: 'available',
  routes: [{
    route_id: 'TB42',
    times: [{ timestamp: stickyFirstPoll + 240, scheduled: true, source: 'static', ...stickyCourse }]
  }]
}, stickyStopId, stickyFirstPoll + 50);
assert.equal(stickyFallbackResult.routes.length, 0,
  'a stale reappearing target update must not undo confirmed passage or resurrect the GTFS fallback');

console.log('virtual-board-arrivals: presentation tests passed');
