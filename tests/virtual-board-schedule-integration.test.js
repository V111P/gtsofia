const assert = require('node:assert/strict');
const fs = require('node:fs');
const handler = require('../api/virtual-board.js');
const stops = require('../data/stops.json');
const tripDestinations = require('../data/trip-destinations.json');

(async () => {
  const scheduleData = JSON.parse(fs.readFileSync(
    require('node:path').join(__dirname, '..', 'realtime-proxy', 'data', 'virtual-board-schedules.json'),
    'utf8'
  ));
  const { extractScheduledArrivals } = await import('../realtime-proxy/lib/schedule-mapper.js');

  // Fixed timestamp: 11:00 in Sofia on a published weekday in this generated index.
  const nowMs = Date.parse('2026-11-13T09:00:00.000Z');
  const arrivals = extractScheduledArrivals(scheduleData, '1247', { nowMs });
  assert.ok(arrivals.length > 100, 'the published timetable index should provide a substantial set of arrivals for stop 1247');

  const routes = handler.mapRealtimeArrivalsToBoard(arrivals, {
    nowMs,
    stopIdentifier: '1247'
  });
  assert.ok(routes.length >= 4, 'all served line/direction groups should survive normalization');
  assert.ok(routes.every(route => route.times.length === 3),
    'every line/direction with at least three services in the six-hour window must expose exactly three upcoming times');

  const tram22 = routes.find(route => route.route_id === 'TM22');
  assert.ok(tram22, 'tram 22 should be present in the real generated timetable');
  assert.equal(tram22.destination, 'Автостанция Изток', 'tram 22 should use its OSM-first terminal name');
  assert.deepEqual(tram22.times.map(time => time.source), ['schedule', 'schedule', 'schedule']);

  // Audit every current per-trip terminal label against the OSM stop-name data.
  // The only expected exceptions are trips to terminal 6798, which has no OSM name.
  const missingOsmTerminals = new Set();
  for (const mapping of Object.values(tripDestinations)) {
    const stopId = String(mapping.terminal_stop_id || '').trim();
    const osmName = handler.resolveOsmDestinationByStopId(stopId, stops);
    if (!osmName) {
      missingOsmTerminals.add(stopId);
      continue;
    }
    assert.equal(
      String(mapping.destination || '').trim().normalize('NFKC').toLocaleLowerCase('bg-BG'),
      osmName.normalize('NFKC').toLocaleLowerCase('bg-BG'),
      `trip destination for terminal ${stopId} must match its OSM name`
    );
  }
  assert.deepEqual([...missingOsmTerminals], ['6798'],
    'only the Bankya terminal 6798 currently lacks OSM enrichment; all other trip destinations must use OSM names');

  console.log('virtual-board-schedule-integration: 6-hour schedule, three-time grouping and OSM destination checks passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
