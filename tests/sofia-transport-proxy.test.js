const assert = require('node:assert/strict');
(async () => {
const { normalizeDecodedFeed } = await import('../sofia-transport-proxy/lib/gtfs-realtime-normalizer.js');
const { serializeFeed } = await import('../sofia-transport-proxy/lib/api-serialization.js');

const now = Math.floor(Date.now() / 1000);
const normalized = normalizeDecodedFeed({
  header: { timestamp: now, incrementality: 0 },
  entity: [
    {
      id: 'entity-1',
      tripUpdate: {
        trip: {
          tripId: 'TB2-COURSE-1',
          routeId: 'TB2',
          directionId: 1,
          startTime: '11:44:00',
          startDate: '20261114',
          scheduleRelationship: 0,
        },
        timestamp: now - 3,
        delay: 45,
        stopTimeUpdate: [{
          stopId: 'TB2-0605',
          stopSequence: 12,
          scheduleRelationship: 0,
          arrival: { time: now + 120, delay: 45, scheduledTime: now + 75, uncertainty: 20 },
          departure: { time: now + 130, delay: 45 },
        }],
      },
    },
    {
      id: 'entity-deleted',
      isDeleted: true,
      tripUpdate: { trip: { tripId: 'SHOULD-NOT-APPEAR' } },
    },
    {
      id: 'entity-trip-properties',
      tripUpdate: {
        tripProperties: { tripId: 'PROPERTIES-TRIP', startDate: '20261114', startTime: '12:00:00' },
        stopTimeUpdate: [],
      },
    },
  ],
}, now);

assert.equal(normalized.feedTimestamp, now);
assert.equal(normalized.tripUpdates.length, 2, 'deleted FeedEntities must not be exposed as active trips');
const trip = normalized.tripUpdates[0];
assert.equal(trip.trip.tripId, 'TB2-COURSE-1');
assert.equal(trip.trip.routeId, 'TB2');
assert.equal(trip.trip.directionId, '1');
assert.equal(trip.trip.startTime, '11:44:00');
assert.equal(trip.trip.startDate, '20261114');
assert.equal(trip.trip.scheduleRelationship, 0);
assert.equal(trip.timestamp, now - 3);
assert.equal(trip.delay, 45);
assert.equal(trip.stopTimeUpdates[0].stopId, 'TB2-0605');
assert.equal(trip.stopTimeUpdates[0].stopSequence, 12);
assert.equal(trip.stopTimeUpdates[0].arrival.time, now + 120);
assert.equal(trip.stopTimeUpdates[0].arrival.scheduledTime, now + 75);
assert.equal(trip.stopTimeUpdates[0].arrival.uncertainty, 20);
assert.equal(normalized.tripUpdates[1].trip, null);
assert.equal(normalized.tripUpdates[1].tripProperties.tripId, 'PROPERTIES-TRIP');

const serialized = serializeFeed(normalized);
assert.equal(serialized.feedTimestamp, now);
assert.equal(serialized.tripUpdates[0].timestampUnix, now - 3);
assert.equal(serialized.tripUpdates[0].stopTimeUpdates[0].arrival.timeUnix, now + 120);
assert.equal(serialized.tripUpdates[0].stopTimeUpdates[0].arrival.scheduledTime, now + 75);
assert.equal(serialized.tripUpdates[0].trip.startDate, '20261114');

assert.throws(() => normalizeDecodedFeed({ header: { timestamp: now - 500 }, entity: [] }, now), /stale/i);
assert.throws(() => normalizeDecodedFeed({ header: { timestamp: now, incrementality: 1 }, entity: [] }, now), /differential/i);
assert.throws(() => normalizeDecodedFeed({ header: { incrementality: 0 }, entity: [] }, now), /timestamp/i);

console.log('sofia-transport-proxy: all tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
