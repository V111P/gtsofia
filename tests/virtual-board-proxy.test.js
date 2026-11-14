const assert = require('node:assert/strict');
const proxy = require('../assets/js/virtual-board-proxy.js');

const normalStop = {
  stop_id: '0328',
  stop_code: '0328'
};
assert.equal(
  proxy.buildProxyUrl(normalStop),
  'https://sft-proxy.onrender.com/virtual-board?stop_code=0328',
  'surface stops must preserve leading zeroes in their public stop code'
);

const metroStop = {
  stop_id: 'M312',
  stop_code: '312'
};
assert.equal(
  proxy.buildProxyUrl(metroStop),
  'https://sft-proxy.onrender.com/virtual-board?stop_code=312&metro',
  'metro stations must use the numeric station code and the legacy metro flag'
);
assert.equal(
  proxy.buildProxyUrl({ stop_id: 'M8', stop_code: '' }),
  'https://sft-proxy.onrender.com/virtual-board?stop_code=8&metro',
  'metro stations without stop_code must derive the numeric code from stop_id'
);

const stopsById = new Map([
  ['M1', { stop_id: 'M1', stop_name: 'Сливница', gtfs_stop_name: 'Сливница' }]
]);
const stopsByCode = new Map([
  ['0245', { stop_id: '0245', stop_code: '0245', osm_stop_name: 'бул. Сливница' }]
]);
const loadedAt = 1_800_000_000;
const payload = {
  status: 'ok',
  generated_at: '2026-11-14T17:00:00.000Z',
  routes: [
    {
      cgm_id: 'TM27',
      route_ref: '1',
      type: 'tram',
      destination: '0245',
      times: [
        { t: 8, extras: ['0', '1', '0'] },
        { t: 3, extras: ['1', '0', '1'] }
      ]
    },
    {
      cgm_id: 'M1',
      route_ref: 'M1',
      type: 'metro',
      destination: '1',
      bg_color: 'EB2227',
      text_color: 'FFFFFF',
      times: [{ t: 4, realtime: true }]
    }
  ]
};

const normalized = proxy.normalizeBoard(payload, {
  stop: normalStop,
  stopsById,
  stopsByCode,
  nowSeconds: loadedAt,
  resolveRouteMetadata: route => ({
    id: route.cgm_id,
    number: route.type === 'metro' ? '1' : route.route_ref,
    type: route.type,
    subtype: '',
    color: '#123456',
    textColor: '#FFFFFF'
  })
});

assert.equal(normalized.status, 'ok');
assert.equal(normalized.loaded_at, loadedAt);
assert.equal(normalized.realtime_status, 'available');
assert.equal(normalized.routes.length, 2);
assert.equal(normalized.routes[0].destination, 'бул. Сливница');
assert.equal(normalized.routes[0].times[0].timestamp, loadedAt + 3 * 60);
assert.equal(normalized.routes[0].times[1].timestamp, loadedAt + 8 * 60);
assert.equal(normalized.routes[0].times[0].scheduled, true,
  'unclassified proxy times should not be presented as confirmed live predictions');
assert.equal(normalized.routes[0].meta.number, '1');
assert.equal(normalized.routes[1].meta.type, 'metro');
assert.equal(normalized.routes[1].meta.color, '#EB2227');
assert.equal(normalized.routes[1].times[0].scheduled, false,
  'an explicit realtime marker should be preserved');

const normalizedMetroDestination = proxy.normalizeBoard({
  status: 'ok',
  routes: [{ route_ref: 'M1', type: 'metro', destination: '1', times: [{ t: 2 }] }]
}, {
  stop: metroStop,
  stopsById,
  nowSeconds: loadedAt
});
assert.equal(normalizedMetroDestination.routes[0].destination, 'Сливница');

const metroBoard = proxy.normalizeBoard({ status: 'ok', routes: [] }, {
  stop: metroStop,
  nowSeconds: loadedAt
});
assert.equal(metroBoard.realtime_status, 'not_applicable');
assert.equal(metroBoard.status, 'ok');
assert.deepEqual(metroBoard.routes, []);

const malformedTimes = proxy.normalizeBoard({
  routes: [{ route_ref: '5', type: 'tram', times: [{ t: 'not-a-number' }, {}] }]
}, {
  stop: normalStop,
  nowSeconds: loadedAt
});
assert.equal(malformedTimes.routes.length, 0,
  'routes without usable arrival times should be omitted');

console.log('virtual-board-proxy: all tests passed');
