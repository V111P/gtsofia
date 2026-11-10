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
  sessionStorage: { getItem: () => '[]', setItem() {} },
  document: { addEventListener() {} },
  window: {},
  Date
};
context.globalThis = context;

vm.runInNewContext(source, context, { filename: sourcePath });
const { formatArrivalCountdown } = context.__gtsofiaVirtualBoardTestInternals;

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

console.log('virtual-board-arrivals: presentation tests passed');
