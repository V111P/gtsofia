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
for (const [offset, expected] of [
  [60, '1 мин.'],
  [59, '1 мин.'],
  [30, '1 мин.'],
  [29, '0 мин.'],
  [0, '0 мин.'],
  [120, '2 мин.'],
  [150, '3 мин.']
]) {
  assert.equal(formatArrivalCountdown(now + offset, now), expected);
}
assert.equal(formatArrivalCountdown('not-a-timestamp', now), '');

assert.deepEqual(
  sortBoardRoutesByNextArrival([
    { route_id: 'TB1', route_ref: '1', times: [{ timestamp: now + 360 }] },
    { route_id: 'TM22', route_ref: '22', times: [{ timestamp: now + 60 }] }
  ]).map(route => route.route_id),
  ['TM22', 'TB1'],
  'the frontend sorts provider arrivals by their actual next realtime timestamp'
);

assert.doesNotMatch(source, /rememberRealtimeArrivalPredictions|reconcileRealtimeCoursePresence|suppressPassedRealtimeFallbacks/,
  'the frontend must not keep or reconcile trip history to recreate board arrivals');
assert.match(source, /filter\(time => time\?\.source === 'realtime' \|\| time\?\.realtime === true\)/,
  'only provider-marked realtime arrivals may reach the renderer');
assert.match(source, /Няма налични realtime пристигания/,
  'an empty realtime response must be described as an empty realtime board');
assert.match(source, /Never keep an old prediction visible/,
  'a failed refresh must not leave stale predictions visible');
assert.doesNotMatch(source, /показваме последните заредени данни/i,
  'the frontend must not present stale predictions as a fallback');
assert.doesNotMatch(source, /setInterval\s*\(/,
  'auto refresh must use chained timeouts, not overlapping intervals');

assert.equal(getBoardAutoRefreshDelay(), 30_000);
recordBoardRefreshOutcome(null, new Error('temporary network failure'));
assert.equal(getBoardAutoRefreshDelay(), 60_000);
recordBoardRefreshOutcome(null, new Error('second network failure'));
assert.equal(getBoardAutoRefreshDelay(), 120_000);
recordBoardRefreshOutcome({ realtime_status: 'available' });
assert.equal(getBoardAutoRefreshDelay(), 30_000);

console.log('virtual-board-arrivals: realtime-only presentation tests passed');
