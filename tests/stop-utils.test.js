const assert = require('node:assert/strict');
const {
  buildStopIndexes,
  compareStopPreference,
  findPreferredStop,
  uniqueStopsById
} = require('../stop-utils');

const parent = {
  stop_id: '0001',
  stop_code: '',
  stop_name: '',
  osm_stop_name: '',
  location_type: '1',
  stop_lat: '42.6924',
  stop_lon: '23.3347'
};
const physical = {
  stop_id: '0001',
  stop_code: '0001',
  stop_name: '102-ро ОУ',
  osm_stop_name: '',
  location_type: '0',
  stop_lat: '42.7364',
  stop_lon: '23.3043'
};
const osmPhysical = {
  ...physical,
  osm_stop_name: '102-ро училище',
  stop_name_source: 'osm'
};
const duplicateOsmPhysical = { ...osmPhysical, stop_lat: '42.7364' };
const stops = [parent, physical, osmPhysical, duplicateOsmPhysical];

const indexes = buildStopIndexes(stops);
assert.equal(indexes.byId.get('0001'), osmPhysical, 'an OSM-enriched physical stop should win over a parent and GTFS-only record');
assert.equal(indexes.byCode.get('0001'), osmPhysical, 'lookup by stop_code should choose the same preferred record');
assert.equal(findPreferredStop(stops, stop => stop.stop_id === '0001'), osmPhysical);
assert.deepEqual(uniqueStopsById(stops), [osmPhysical], 'map/search lists should contain one preferred representative per stop_id');

const tiedA = { stop_id: 'TIE', stop_code: '10', stop_name: 'Stop', osm_stop_name: 'OSM name', location_type: '0', marker: 'first' };
const tiedB = { ...tiedA, marker: 'second' };
assert.equal(compareStopPreference(tiedA, tiedB), 0, 'identical ranking fields must compare equally');
assert.equal(buildStopIndexes([tiedA, tiedB]).byId.get('TIE'), tiedA, 'ties must be stable and retain the first row');
assert.equal(uniqueStopsById([tiedA, tiedB])[0], tiedA, 'deduplication must use the same stable tie-breaker');

console.log('stop-utils: all tests passed');
