const assert = require('node:assert/strict');

(async () => {
  const {
    extractScheduledArrivals,
    mergeRealtimeAndScheduledArrivals
  } = await import('../realtime-proxy/lib/schedule-mapper.js');

  const now = Date.parse('2026-11-13T05:00:00.000Z'); // 07:00 in Sofia
  const scheduleData = {
    calendar: {
      referenceDate: '2026-11-13',
      coverageEndDate: '2026-11-15',
      coverageDays: 3,
      serviceBits: {
        weekday: '5', // 101b: Friday and Sunday
        weekend: '2'
      }
    },
    stopIdsByIdentifier: { '1247': ['1247'] },
    routes: {
      TM22: {
        routeId: 'TM22',
        routeShortName: '22',
        routeType: '0',
        routeColor: 'F7941D',
        routeTextColor: 'FFFFFF',
        directions: {
          D1: {
            headsign: 'Автостанция Изток',
            destination: 'Автостанция Изток',
            terminalStopId: '2023',
            stopIds: ['0633', '1247', '0470', '2023'],
            courses: [
              { tripId: 'no-rt-update', serviceId: 'weekday', times: ['07:00:00', '07:13:00', '07:39:00', '07:49:00'] },
              { tripId: 'has-rt-update', serviceId: 'weekday', times: ['07:01:00', '07:14:00', '07:40:00', '07:50:00'] },
              { tripId: 'skipped-here', serviceId: 'weekday', times: ['07:02:00', '07:15:00', '07:41:00', '07:51:00'] },
              { tripId: 'no-data-here', serviceId: 'weekday', times: ['07:03:00', '07:16:00', '07:42:00', '07:52:00'] },
              { tripId: 'cancelled-course', serviceId: 'weekday', times: ['07:04:00', '07:17:00', '07:43:00', '07:53:00'] }
            ]
          }
        }
      }
    }
  };

  const arrivals = extractScheduledArrivals(scheduleData, '1247', { nowMs: now });
  assert.equal(arrivals.length, 5);
  assert.ok(arrivals.every(item => item.isScheduled && item.source === 'schedule'));
  assert.ok(arrivals.every(item => item.routeId === 'TM22'));
  assert.equal(arrivals[0].arrivalDate, '2026-11-13T05:13:00.000Z');

  const merged = mergeRealtimeAndScheduledArrivals({
    scheduledArrivals: arrivals,
    realtimeArrivals: [{
      tripId: 'has-rt-update', stopId: 'TM1247',
      arrivalDate: '2026-11-13T05:14:30.000Z', isRealtime: true, source: 'realtime'
    }],
    requestedStopIds: ['TM1247'],
    stopIdentifier: '1247',
    updates: [
      { tripId: 'has-rt-update', tripScheduleRelationship: 0, stopTimeUpdates: [
        { stopId: 'TM1247', scheduleRelationship: 0, arrival: { time: '2026-11-13T05:14:30.000Z' } }
      ] },
      { tripId: 'skipped-here', tripScheduleRelationship: 0, stopTimeUpdates: [
        { stopId: 'TM1247', scheduleRelationship: 1 }
      ] },
      { tripId: 'no-data-here', tripScheduleRelationship: 0, stopTimeUpdates: [
        { stopId: 'TM1247', scheduleRelationship: 2 }
      ] },
      { tripId: 'cancelled-course', tripScheduleRelationship: 3, stopTimeUpdates: [] }
    ]
  });

  const byTrip = new Map(merged.map(item => [item.tripId, item]));
  assert.equal(byTrip.get('no-rt-update').source, 'schedule', 'no update at this stop uses timetable');
  assert.equal(byTrip.get('has-rt-update').source, 'realtime', 'explicit RT event takes precedence over timetable');
  assert.equal(byTrip.has('skipped-here'), false, 'SKIPPED suppresses both RT and scheduled arrival');
  assert.equal(byTrip.get('no-data-here').source, 'schedule', 'NO_DATA falls back to timetable');
  assert.equal(byTrip.has('cancelled-course'), false, 'canceled trip never falls back to timetable');

  const feedUnavailable = mergeRealtimeAndScheduledArrivals({ scheduledArrivals: arrivals });
  assert.equal(feedUnavailable.length, 5, 'the timetable is still available if the RT feed is unavailable');

  // RT and the site's schedule export can use different stop_id namespaces
  // for the same public board (for example, TM1247 vs 1247). The merge must
  // compare a trip against the canonical requested board identifier.
  const namespaceBridge = mergeRealtimeAndScheduledArrivals({
    scheduledArrivals: [
      { tripId: 'same-trip', stopId: '1247', arrivalDate: '2026-11-13T05:13:00.000Z', source: 'schedule', isScheduled: true },
      { tripId: 'no-update-trip', stopId: '1247', arrivalDate: '2026-11-13T05:15:00.000Z', source: 'schedule', isScheduled: true }
    ],
    realtimeArrivals: [{
      tripId: 'same-trip', stopId: 'TM1247', arrivalDate: '2026-11-13T05:12:30.000Z',
      source: 'realtime', isRealtime: true
    }],
    requestedStopIds: ['TM1247'],
    stopIdentifier: '1247',
    updates: [{ tripId: 'same-trip', stopTimeUpdates: [{
      stopId: 'TM1247', scheduleRelationship: 0, arrival: { time: '2026-11-13T05:12:30.000Z' }
    }] }]
  });
  assert.deepEqual(namespaceBridge.map(item => `${item.tripId}:${item.source}`).sort(), [
    'no-update-trip:schedule', 'same-trip:realtime'
  ], 'RT for the same trip/public stop suppresses duplicate timetable fallback despite different GTFS stop_id namespaces');

  console.log('realtime-proxy-schedule: timetable fallback tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
