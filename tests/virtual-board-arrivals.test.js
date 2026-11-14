const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'virtual-boards.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const context = {
  console,
  Math,
  Intl,
  URLSearchParams,
  localStorage: { getItem: () => '[]', setItem() {} },
  document: { addEventListener() {} },
  window: {},
  Date
};
context.globalThis = context;

vm.runInNewContext(source, context, { filename: sourcePath });
const {
  formatArrivalCountdown,
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
  assert.equal(formatArrivalCountdown(now + offset, now), expected, `${label} should round to ${expected}`);
}

assert.equal(formatArrivalCountdown('not-a-timestamp', now), '', 'invalid timestamps should render as an empty label');
assert.equal(
  formatArrivalCountdown(now + 541, now),
  formatArrivalCountdown(now + 541, now),
  'the same arrival must keep the same displayed minutes while the board snapshot timestamp is unchanged'
);

const sorted = sortBoardRoutesByNextArrival([
  { route_id: 'B', route_ref: '2', times: [{ timestamp: 1_200 }, { timestamp: 1_100 }] },
  { route_id: 'A', route_ref: '1', times: [{ timestamp: 1_050 }] }
]);
assert.deepEqual(sorted.map(route => route.route_id), ['A', 'B'], 'line rows should sort by their next arrival');
assert.deepEqual(sorted[1].times.map(time => time.timestamp), [1_100, 1_200], 'times in a line should be sorted chronologically');

// A stateless full-dataset feed must be reconciled on the server. The browser
// must not guess that a vehicle passed because a TripUpdate disappeared or
// contains only downstream stop updates.
assert.doesNotMatch(source, /REALTIME_ARRIVAL_HISTORY_KEY|readRealtimeArrivalHistory|rememberRealtimeArrivalPredictions/);
assert.doesNotMatch(source, /reconcileRealtimeCoursePresence|suppressPassedRealtimeFallbacks/);
assert.doesNotMatch(source, /passed_realtime_fallbacks_suppressed/);
assert.match(source, /return normalized;/, 'the browser should render the server-resolved board without a second fallback filter');

assert.doesNotMatch(source, /\bsetInterval\s*\(/, 'auto refresh must use a single chained timeout, never overlapping intervals');
assert.doesNotMatch(source, /updateBoardCountdowns|startTimers|data-arrival-timestamp/, 'continuous per-second countdown timers must remain removed');
assert.match(source, /BOARD_AUTO_REFRESH_INTERVAL_MS = 30_000/, 'normal auto refresh must use a restrained 30-second interval');
assert.match(source, /BOARD_AUTO_REFRESH_STATIC_INTERVAL_MS = 60_000/, 'schedule-only metro boards should refresh less frequently');
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

console.log('virtual-board-arrivals: presentation tests passed');
