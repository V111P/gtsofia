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
const testExposure = `
  globalThis.__testInternals = {
    formatArrivalCountdown,
    countdownHtml,
    sortBoardRoutesByNextArrival,
    renderBoardList,
    renderBoardStatus,
    getBoardAutoRefreshDelay,
    recordBoardRefreshOutcome
  };
`;
const closing = '})();';
const closingIndex = source.lastIndexOf(closing);
assert.notEqual(closingIndex, -1, 'virtual board module should have a single IIFE closing');
const instrumentedSource = source.slice(0, closingIndex)
  + testExposure
  + source.slice(closingIndex);
vm.runInNewContext(instrumentedSource, context, { filename: sourcePath });

const {
  formatArrivalCountdown,
  countdownHtml,
  sortBoardRoutesByNextArrival,
  renderBoardList,
  renderBoardStatus,
  getBoardAutoRefreshDelay,
  recordBoardRefreshOutcome
} = context.__testInternals;

const now = 1_000;
for (const [offset, expected] of [
  [60, '1 мин.'],
  [59, '1 мин.'],
  [30, '1 мин.'],
  [29, '1 мин.'],
  [0, '0 мин.'],
  [120, '2 мин.'],
  [150, '3 мин.'],
  [121, '3 мин.']
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

assert.doesNotMatch(source, /__gtsofiaVirtualBoardTestInternals/,
  'the browser bundle must not expose test-only internals');
assert.doesNotMatch(source, /rememberRealtimeArrivalPredictions|reconcileRealtimeCoursePresence|suppressPassedRealtimeFallbacks/,
  'the frontend must not keep or reconcile trip history to recreate board arrivals');
assert.match(source, /time\?\.source === 'schedule' \|\| time\?\.scheduled === true/,
  'the renderer accepts timetable rows only through the metro schedule exception');
assert.match(source, /const isMetro = route\?\.meta\?\.type === 'metro'/,
  'timetable arrivals are restricted to routes classified as metro');
assert.doesNotMatch(source, /По разписание/,
  'metro timetable arrivals do not display a scheduled label');
assert.match(source, /Няма налични realtime пристигания/,
  'an empty surface transport response must be described as an empty realtime board');
assert.match(source, /Няма предстоящи метрокурсове\./,
  'empty metro boards use a neutral empty-state message');
assert.match(source, /Never keep an old prediction visible/,
  'a failed refresh must not leave stale predictions visible');
assert.doesNotMatch(source, /показваме последните заредени данни/i,
  'the frontend must not present stale predictions as a fallback');
assert.doesNotMatch(source, /Метролиниите се показват по официалното разписание/,
  'metro boards do not display a realtime disclaimer');
assert.doesNotMatch(source, /vb-scheduled-label/,
  'the scheduled badge is removed from the virtual-board frontend');

const panelElements = {
  '.vb-board-status': { innerHTML: 'previous status' },
  '.virtual-board-list': { innerHTML: '' }
};
const panel = {
  querySelector(selector) {
    return panelElements[selector] || null;
  }
};

renderBoardList(panel, {
  status: 'ok',
  board_mode: 'realtime',
  realtime_status: 'available',
  loaded_at: now,
  routes: [{
    route_id: 'TM22',
    route_ref: '22',
    destination: '',
    headsign: '',
    meta: { number: '22', type: 'tram', color: '#F7941D', textColor: '#FFFFFF' },
    times: [{ timestamp: now + 300, source: 'realtime', realtime: true, scheduled: false }]
  }]
});
assert.doesNotMatch(panelElements['.virtual-board-list'].innerHTML, /vb-route-row|schedule-line-pill|vb-destination/,
  'the entire route-and-direction row is omitted when the trip terminates at the open stop');
assert.match(panelElements['.virtual-board-list'].innerHTML, /vb-time-block vb-time-block--no-direction/,
  'arrival times remain visible and align without the hidden direction row');

renderBoardList(panel, {
  status: 'ok',
  board_mode: 'metro-schedule',
  realtime_status: 'not_applicable',
  realtime_message: 'Legacy metro notice from an older API deployment.',
  loaded_at: now,
  routes: [{
    route_id: 'M1',
    route_ref: '1',
    destination: 'Бизнес парк София',
    meta: { number: '1', type: 'metro', color: '#1C75BC', textColor: '#FFFFFF' },
    times: [{ timestamp: now + 300, source: 'schedule', scheduled: true, realtime: false }]
  }]
});
assert.equal(panelElements['.vb-board-status'].innerHTML, '',
  'metro board does not render the realtime disclaimer');
assert.doesNotMatch(panelElements['.virtual-board-list'].innerHTML, /По разписание|Метролиниите се показват/,
  'metro times display without schedule or realtime-disclaimer labels');
assert.match(panelElements['.virtual-board-list'].innerHTML, /Бизнес парк София/,
  'metro destination remains visible');

assert.doesNotMatch(source, /setInterval\s*\(/,
  'auto refresh must use chained timeouts, not overlapping intervals');

assert.equal(getBoardAutoRefreshDelay(), 30_000);
recordBoardRefreshOutcome(null, new Error('temporary network failure'));
assert.equal(getBoardAutoRefreshDelay(), 60_000);
recordBoardRefreshOutcome(null, new Error('second network failure'));
assert.equal(getBoardAutoRefreshDelay(), 120_000);
recordBoardRefreshOutcome({ realtime_status: 'available' });
assert.equal(getBoardAutoRefreshDelay(), 30_000);

console.log('virtual-board-arrivals: realtime + metro timetable presentation tests passed');
