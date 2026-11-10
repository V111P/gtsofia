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
  suppressPassedRealtimeFallbacks
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
assert.doesNotMatch(source, /\bsetInterval\s*\(/, 'virtual boards must not start periodic refresh or countdown timers');
assert.doesNotMatch(source, /updateBoardCountdowns|startTimers|data-arrival-timestamp/, 'automatic minute updates and their DOM hooks must be removed');
assert.doesNotMatch(source, /Realtime прогнози и GTFS разписание/, 'the generic realtime/GTFS status label must be removed');

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
const afterArrival = 14 * 3600 + 40 * 60;
rememberRealtimeArrivalPredictions(previousRealtimeSnapshot, stopId, beforeArrival);

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

console.log('virtual-board-arrivals: presentation tests passed');
