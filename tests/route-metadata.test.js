const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getRouteMetadata, normalizeRouteRef } = require('../route-metadata');

const routesPath = path.join(__dirname, '..', 'data', 'routes.json');
const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
const byId = new Map(routes.map(route => [route.route_id, route]));

assert.equal(routes.length, 206, 'the current GTFS snapshot should contain 206 routes');
assert.equal(normalizeRouteRef('E186'), '186');
assert.equal(normalizeRouteRef('Е186'), '186');
assert.equal(normalizeRouteRef('N1'), 'N1');
assert.equal(normalizeRouteRef('Y1'), 'У1');
assert.equal(normalizeRouteRef('12T'), '12ТМ');
assert.equal(normalizeRouteRef('3TM'), '3ТМ');
assert.equal(normalizeRouteRef('1Tb'), '1ТБ');
assert.equal(normalizeRouteRef('M3'), 'M3');

function metadata(routeId) {
  const route = byId.get(routeId);
  assert.ok(route, `missing GTFS route ${routeId}`);
  return getRouteMetadata(route);
}

// These are the important cases in Dimitar's scripts/03-routes.js and
// src/js/schedules.js: numeric trolleybus routes >= 50 become buses, and
// temporary replacement routes receive Cyrillic suffixes/subtypes.
assert.deepEqual(
  { number: metadata('TB26').number, type: metadata('TB26').type, subtype: metadata('TB26').subtype },
  { number: '184', type: 'bus', subtype: '' }
);
assert.deepEqual(
  { number: metadata('TB25').number, type: metadata('TB25').type, subtype: metadata('TB25').subtype },
  { number: '84', type: 'bus', subtype: '' }
);
assert.deepEqual(
  { number: metadata('TB37').number, type: metadata('TB37').type, subtype: metadata('TB37').subtype },
  { number: '3ТМ', type: 'bus', subtype: 'temporary' }
);
assert.deepEqual(
  { number: metadata('TB38').number, type: metadata('TB38').type, subtype: metadata('TB38').subtype },
  { number: '12ТМ', type: 'bus', subtype: 'temporary' }
);
assert.deepEqual(
  { number: metadata('TB34').number, type: metadata('TB34').type, subtype: metadata('TB34').subtype },
  { number: '20ТМ', type: 'bus', subtype: 'temporary' }
);
assert.deepEqual(
  { number: metadata('TB46').number, type: metadata('TB46').type, subtype: metadata('TB46').subtype },
  { number: '186', type: 'bus', subtype: '' }
);
for (const [routeId, expectedNumber] of [
  ['TB43', '288'],
  ['TB35', '60'],
  ['TB36', '74'],
  ['TB39', '73'],
  ['TB24', '123'],
  ['TB41', '801']
]) {
  assert.deepEqual(
    { number: metadata(routeId).number, type: metadata(routeId).type },
    { number: expectedNumber, type: 'bus' },
    `${routeId} must follow Dimitar's replacement-bus classification`
  );
}
assert.deepEqual(
  { number: metadata('A241').number, type: metadata('A241').type, subtype: metadata('A241').subtype },
  { number: 'M3', type: 'bus', subtype: 'temporary' }
);
assert.deepEqual(
  { number: metadata('A190').number, type: metadata('A190').type, subtype: metadata('A190').subtype },
  { number: '1ТБ', type: 'bus', subtype: 'temporary' }
);
assert.deepEqual(
  { number: metadata('A259').number, type: metadata('A259').type, subtype: metadata('A259').subtype },
  { number: 'X43', type: 'bus', subtype: '' }
);

// Metro is displayed without the M prefix in this project. The prefix is
// stripped only after route type detection, so the temporary bus M3 is kept.
for (const [routeId, expectedNumber] of [['M1', '1'], ['M2', '2'], ['M3', '3'], ['M4', '4']]) {
  assert.equal(metadata(routeId).number, expectedNumber, `${routeId} must display without an M prefix`);
  assert.equal(metadata(routeId).type, 'metro');
}
assert.equal(metadata('M1').color, '#EB2227');
assert.equal(metadata('A241').number, 'M3', 'the M3 replacement bus must retain its M prefix');
assert.equal(metadata('A241').type, 'bus');
assert.equal(metadata('A241').subtype, 'temporary');
assert.equal(metadata('TB26').color, '#BE1E2D');
assert.equal(metadata('TB26').icon, 'Icons/Active icons/bus.svg');


// Night services are still buses, but their pill uses the dedicated GTFS
// night-line colour (black) and their night-bus icon.
for (const routeId of ['A224', 'A225', 'A226', 'A227']) {
  const night = metadata(routeId);
  assert.equal(night.type, 'bus');
  assert.equal(night.subtype, 'night');
  assert.equal(night.color, '#000000');
  assert.equal(night.textColor, '#FFFFFF');
  assert.equal(night.icon, 'Icons/Active icons/night-bus.svg');
}

// Manual overrides are keyed by the original GTFS route_id and are applied
// after automatic classification. Only the supplied fields are overridden.
assert.deepEqual(
  (({ number, type, subtype, color }) => ({ number, type, subtype, color }))(
    getRouteMetadata(byId.get('TB26'), {
      TB26: { number: '184X', type: 'bus', color: '#123456' }
    })
  ),
  { number: '184X', type: 'bus', subtype: '', color: '#123456' }
);
assert.equal(
  getRouteMetadata(byId.get('A224'), { A224: { subtype: '' } }).subtype,
  '',
  'an explicit empty subtype must clear the automatically detected subtype'
);
assert.equal(
  getRouteMetadata(byId.get('M1'), { M1: { number: 'М1' } }).number,
  'М1',
  'an explicit number override must be respected, including for metro'
);

// Every route must resolve to a usable normalized type and display number.
for (const route of routes) {
  const result = getRouteMetadata(route);
  assert.ok(result.number && result.number !== '—', `route ${route.route_id} has no normalized number`);
  assert.ok(['metro', 'tram', 'trolley', 'bus', 'other'].includes(result.type), `route ${route.route_id} has an unknown type`);
}

console.log('route-metadata: all tests passed');
