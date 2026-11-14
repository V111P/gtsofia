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
    },
    {
      cgm_id: 'T_EMPTY',
      route_ref: '99',
      type: 'bus',
      destination: '0245',
      times: []
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
assert.equal(normalized.routes.length, 3,
  'every route returned by the proxy must be retained, even when it has no times');
assert.equal(normalized.routes[0].destination, 'бул. Сливница');
assert.equal(normalized.routes[0].times[0].t, 3,
  'proxy relative minutes must be kept as the source value');
assert.equal(normalized.routes[0].times[1].t, 8,
  'arrivals within a route stay sorted by the proxy relative-minute value');
assert.deepEqual(normalized.routes[0].times[0].extras, ['1', '0', '1'],
  'additional proxy arrival fields must be preserved');
assert.equal('timestamp' in normalized.routes[0].times[0], false,
  'the frontend must not synthesize timestamps from proxy minutes');
assert.equal('scheduled' in normalized.routes[0].times[0], false,
  'the frontend must not invent realtime/scheduled classifications');
assert.equal(normalized.routes[0].meta.number, '1');
assert.equal(normalized.routes[1].meta.type, 'metro');
assert.equal(normalized.routes[1].meta.color, '#EB2227');
assert.equal(normalized.routes[1].times[0].realtime, true,
  'an explicit realtime marker must be preserved');
assert.deepEqual(normalized.routes[2].times, [],
  'routes with empty times must not be removed');

assert.equal(proxy.getMinutesUntilArrival({ t: '4' }), 4);
assert.equal(proxy.getMinutesUntilArrival({ t: 2.5 }), 2.5,
  'fractional proxy minutes must remain fractional instead of being rounded');
assert.equal(proxy.getMinutesUntilArrival({ t: null }), null);

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
assert.equal(malformedTimes.routes.length, 1,
  'routes with malformed arrivals must not be dropped');
assert.equal(malformedTimes.routes[0].times.length, 2,
  'malformed arrival objects must be preserved for transparent rendering/debugging');

console.log('virtual-board-proxy: all tests passed');
