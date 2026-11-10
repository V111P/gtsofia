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

// If a realtime prediction was shown before the vehicle arrived, remember
// that exact trip. The next feed may already have removed it; its later GTFS
// timetable time must not resurrect the same course ahead of the next trip.
const stopId = '0470';
const previousRealtimeSnapshot = {
  routes: [{
    route_id: 'TM22',
    trip_id: 'TM22-TRIP-42',
    trip_start_date: '20261110',
    trip_start_time: '14:00:00',
    direction_id: '2',
    realtime: true,
    times: [{
      timestamp: 14 * 3600 + 39 * 60,
      scheduled: false,
      source: 'realtime',
      route_id: 'TM22',
      trip_id: 'TM22-TRIP-42',
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
// the earlier estimate elapses. Keep the earliest observed estimate so the
// old GTFS 14:42 time cannot resurrect the same early-running vehicle.
const revisedRealtimeSnapshot = {
  routes: [{
    route_id: 'TM22',
    trip_id: 'TM22-TRIP-42',
    trip_start_date: '20261110',
    trip_start_time: '14:00:00',
    direction_id: '0',
    realtime: true,
    times: [{
      timestamp: 14 * 3600 + 41 * 60,
      scheduled: false,
      source: 'realtime',
      route_id: 'TM22',
      trip_id: 'TM22-TRIP-42',
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

console.log('virtual-board-arrivals: presentation tests passed');
