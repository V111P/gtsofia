const assert = require('node:assert/strict');
const { normalizeProxyFeed } = require('../services/sofia-transport-client');

const now = Math.floor(Date.now() / 1000);
const normalized = normalizeProxyFeed({
  feedTimestamp: now,
  feedIncrementality: 0,
  tripUpdates: [{
    entityId: 'entity-1',
    timestamp: new Date((now - 2) * 1000).toISOString(),
    timestampUnix: now - 2,
    trip: {
      tripId: 'TB2-COURSE-1',
      routeId: 'TB2',
      directionId: '1',
      startTime: '11:44:00',
      startDate: '20261114',
      scheduleRelationship: 0,
    },
    delay: 30,
    stopTimeUpdates: [{
      stopId: 'TB2-0605',
      stopSequence: 12,
      scheduleRelationship: 0,
      arrival: {
        time: new Date((now + 120) * 1000).toISOString(),
        timeUnix: now + 120,
        delay: 30,
        scheduledTime: now + 90,
        uncertainty: 15,
      },
      departure: null,
    }],
  }],
});

assert.equal(normalized.provider, 'sofia-transport-api');
assert.equal(normalized.feedTimestamp, now);
assert.equal(normalized.updates.length, 1);
assert.equal(normalized.updates[0].trip.tripId, 'TB2-COURSE-1');
assert.equal(normalized.updates[0].trip.routeId, 'TB2');
assert.equal(normalized.updates[0].trip.directionId, '1');
assert.equal(normalized.updates[0].trip.startTime, '11:44:00');
assert.equal(normalized.updates[0].trip.startDate, '20261114');
assert.equal(normalized.updates[0].stopTimeUpdates[0].stopSequence, 12);
assert.equal(normalized.updates[0].stopTimeUpdates[0].arrival.time, now + 120);
assert.equal(normalized.updates[0].stopTimeUpdates[0].arrival.scheduledTime, now + 90);
assert.equal(normalized.updates[0].stopTimeUpdates[0].arrival.uncertainty, 15);

assert.throws(() => normalizeProxyFeed({ tripUpdates: [] }), /feedTimestamp/i);
assert.throws(() => normalizeProxyFeed({ feedTimestamp: now - 500, tripUpdates: [] }), /stale/i);
assert.throws(() => normalizeProxyFeed({ feedTimestamp: now, feedIncrementality: 1, tripUpdates: [] }), /differential/i);
assert.throws(() => normalizeProxyFeed({
  feedTimestamp: now,
  tripUpdates: [{ trip: {}, stopTimeUpdates: [] }],
}), /trip ID/i);

console.log('sofia-transport-client: all tests passed');
