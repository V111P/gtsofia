const assert = require('node:assert/strict');
const { normalizeRoutes } = require('../virtual-board-arrival-utils.js');

const normalized = normalizeRoutes([
  {
    route_id: 'TM22',
    meta: { type: 'tram' },
    times: [
      { timestamp: 100, source: 'realtime' },
      { timestamp: 200, source: 'schedule' },
      { timestamp: 300, scheduled: true },
      { timestamp: 400, source: 'schedule' },
      { timestamp: 500, source: 'unknown' }
    ]
  },
  {
    route_id: 'M1',
    meta: { type: 'metro' },
    times: [
      { timestamp: 100, source: 'realtime' },
      { timestamp: 200, source: 'schedule' }
    ]
  }
]);

assert.equal(normalized.length, 2);
assert.equal(normalized[0].times.length, 3, 'the frontend is a final safety net: never show more than three times per line/direction');
assert.deepEqual(normalized[0].times.map(time => time.source), [
  'realtime', 'schedule', 'schedule'
], 'surface board keeps both realtime and scheduled fallback times');
assert.deepEqual(normalized[0].times.map(time => [time.realtime, time.scheduled]), [
  [true, false], [false, true], [false, true]
]);
assert.equal(normalized[0].realtime, true);
assert.equal(normalized[0].scheduled, true);
assert.deepEqual(normalized[1].times.map(time => time.source), ['schedule'],
  'metro remains schedule-only');
console.log('virtual-board-arrival-utils: source normalization tests passed');
