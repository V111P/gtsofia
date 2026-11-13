const assert = require('node:assert/strict');

(async () => {
  const { extractRealtimeArrivals } = await import('../realtime-proxy/lib/arrival-mapper.js');
  const { findStopIds } = await import('../realtime-proxy/lib/stop-id-matcher.js');
  assert.deepEqual(findStopIds([
    { id: 'M1', code: '1' },
    { id: 'M2', code: '2' },
    { id: '1247', code: '1247' },
    { id: 'M312_A', code: '' }
  ], 'M1'), ['M1'], 'an exact GTFS stop_id should resolve without code collisions');
  assert.deepEqual(findStopIds([
    { id: 'M1', code: '1' },
    { id: 'M2', code: '2' }
  ], '2'), ['M2'], 'a public stop_code should resolve to its GTFS stop_id');
  assert.deepEqual(findStopIds([{ id: 'M312_A', code: '' }], 'M312_A'), ['M312_A']);

  const now = Date.now();
  const time = minutes => new Date(now + minutes * 60_000).toISOString();
  const tripLookup = {
    'TM22-1': {
      routeId: 'TM22',
      routeShortName: '22',
      routeType: '0',
      routeColor: 'F7941D',
      routeTextColor: 'FFFFFF',
      headsign: 'Автостанция Изток'
    }
  };
  const entities = [
    {
      tripId: 'TM22-1',
      routeId: 'TM22',
      stopTimeUpdates: [
        { stopId: '1247', arrival: { time: time(5), delay: 90 }, scheduleRelationship: 0 },
        // Even an inconsistent event time must be suppressed for NO_DATA.
        { stopId: '1247', arrival: { time: time(6) }, scheduleRelationship: 2 },
        { stopId: '1247', departure: { time: time(7) }, scheduleRelationship: 1 },
        // A delay-only RT update is not enough to create a time.
        { stopId: '1247', arrival: { time: null, delay: 120 }, scheduleRelationship: 0 },
        // Updates for another stop must not leak into this stop's board.
        { stopId: '0470', arrival: { time: time(8) }, scheduleRelationship: 0 }
      ]
    },
    {
      tripId: 'cancelled',
      tripScheduleRelationship: 3,
      stopTimeUpdates: [{ stopId: '1247', arrival: { time: time(9) } }]
    },
    {
      tripId: 'deleted',
      tripScheduleRelationship: 7,
      stopTimeUpdates: [{ stopId: '1247', arrival: { time: time(10) } }]
    },
    {
      tripId: 'no-explicit-time',
      stopTimeUpdates: [{ stopId: '1247', arrival: { delay: 180 } }]
    }
  ];

  const arrivals = extractRealtimeArrivals(entities, ['1247'], { now, tripLookup });
  assert.equal(arrivals.length, 1, 'only one explicit, valid RT time should remain');
  assert.equal(arrivals[0].routeId, 'TM22');
  assert.equal(arrivals[0].routeShortName, '22');
  assert.equal(arrivals[0].headsign, 'Автостанция Изток');
  assert.equal(arrivals[0].stopId, '1247');
  assert.equal(arrivals[0].delaySeconds, 90);
  assert.equal(arrivals[0].isRealtime, true);

  const departureOnly = extractRealtimeArrivals([{
    tripId: 'departure-only',
    stopTimeUpdates: [{ stopId: '1247', departure: { time: time(4), delay: 30 } }]
  }], ['1247'], { now });
  assert.equal(departureOnly.length, 1, 'an explicit departure time is a valid stop event');

  const empty = extractRealtimeArrivals(entities, ['not-this-stop'], { now, tripLookup });
  assert.deepEqual(empty, [], 'no schedule-based row is synthesized when the stop has no RT event');

  console.log('realtime-proxy-arrivals: explicit RT-only extraction tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
