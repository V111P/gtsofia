const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const test = require('node:test');
const routeMetadata = require('../route-metadata');

const sourcePath = path.join(__dirname, '..', 'transport-data.js');
const source = fs.readFileSync(sourcePath, 'utf8');

test('loadTransportData merges the modular files into the legacy in-memory shape', async () => {
  const payloads = {
    'metadata.json': { updatedAt: '2026-10-27' },
    'calendar.json': { serviceIdsByDate: { '2026-10-27': ['S1'] } },
    'routes.json': [{ route_id: 'R1', route_short_name: '184', route_type: '11' }],
    'stops.json': [{ stop_id: '0001' }],
    'trips.json': [{ trip_id: 'T1', route_id: 'R1', service_id: 'S1' }],
    'directions.json': { R1: { D1: { headsign: 'Test' } } },
    'shapes.json': { SH1: [{ lat: 42.7, lon: 23.3 }] },
    'schedules.json': { R1: { D1: { weekday: [], weekend: [] } } },
    'route-overrides.json': { R1: { number: '184', type: 'bus' } }
  };
  const requests = [];
  const context = {
    console,
    Intl,
    Date,
    fetch: async (url) => {
      requests.push(url);
      const filename = String(url).split('/').at(-1);
      assert.ok(Object.hasOwn(payloads, filename), `unexpected request: ${url}`);
      return {
        ok: true,
        status: 200,
        json: async () => payloads[filename]
      };
    },
    GTSofiaRouteMetadata: routeMetadata,
    window: null
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: sourcePath });

  const data = await context.loadTransportData();
  assert.equal(data.updatedAt, '2026-10-27');
  assert.equal(data.routes[0].route_id, 'R1');
  assert.equal(data.routes[0].number, '184');
  assert.equal(data.routes[0].type, 'bus');
  assert.equal(data.stops[0].stop_id, '0001');
  assert.equal(data.trips[0].service_id, 'S1');
  assert.equal(data.directions.R1.D1.headsign, 'Test');
  assert.equal(data.shapes.SH1[0].lat, 42.7);
  assert.deepEqual(JSON.parse(JSON.stringify(data.calendar.serviceIdsByDate['2026-10-27'])), ['S1']);
  assert.equal(data.schedules.R1.D1.weekday.length, 0);
  assert.equal(context.transportData, data);
  assert.equal(requests.length, 9);

  const secondRead = await context.loadTransportData();
  assert.equal(secondRead, data);
  assert.equal(requests.length, 9, 'the successful load should be cached');
});

test('failed modular fetch can be retried', async () => {
  let fail = true;
  const context = {
    console,
    Intl,
    Date,
    GTSofiaRouteMetadata: routeMetadata,
    fetch: async (url) => {
      if (fail) {
        fail = false;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      const filename = String(url).split('/').at(-1);
      return {
        ok: true,
        status: 200,
        json: async () => filename === 'metadata.json' ? {} : (filename === 'route-overrides.json' ? {} : [])
      };
    },
    window: null
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: sourcePath });

  await assert.rejects(context.loadTransportData(), /503/);
  const data = await context.loadTransportData();
  assert.ok(Array.isArray(data.routes));
});
