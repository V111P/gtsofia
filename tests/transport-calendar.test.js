const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'transport-data.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const context = {
  console,
  Intl,
  Date,
  window: null
};
context.window = context;
vm.runInNewContext(source, context, { filename: sourcePath });

context.transportData = {
  calendar: {
    servicePatterns: [
      {
        service_id: 'WD',
        monday: '1', tuesday: '1', wednesday: '1',
        thursday: '1', friday: '1', saturday: '0', sunday: '0',
        start_date: '20260901', end_date: '20260930'
      },
      {
        service_id: 'WE',
        monday: '0', tuesday: '0', wednesday: '0',
        thursday: '0', friday: '0', saturday: '1', sunday: '1',
        start_date: '20260901', end_date: '20260930'
      }
    ],
    exceptions: [
      { service_id: 'WD', date: '20260922', exception_type: '2' },
      { service_id: 'WE', date: '20260922', exception_type: '1' }
    ],
    dateTypes: {
      '2026-09-23': 'weekday'
    },
    config: {
      dateOverrides: {
        '2026-09-22': 'weekend'
      }
    }
  }
};

assert.equal(
  context.getTransportCalendarDayType(new Date('2026-09-22T12:00:00Z')),
  'weekend'
);

assert.equal(
  context.getTransportCalendarDayType(new Date('2026-09-23T12:00:00Z')),
  'weekday'
);

assert.equal(
  context.getTransportCalendarDayType(new Date('2026-09-26T12:00:00Z')),
  'weekend'
);

// A GTFS exception by itself must not be interpreted as a holiday UI type.
context.transportData.calendar.config.dateOverrides = {};
context.transportData.calendar.dateTypes = {};
assert.equal(
  context.getTransportCalendarDayType(new Date('2026-09-22T12:00:00Z')),
  'weekday'
);

console.log('transport-calendar: all tests passed');
