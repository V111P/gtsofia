const assert = require('node:assert/strict');
const handler = require('../api/virtual-board.js');
const { buildVirtualBoard } = require('../api/virtual-board-service');

function createResponse() {
  return {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
    setHeader() {}
  };
}

async function requestBoard(stopCode) {
  const req = { method: 'GET', query: { stop_code: stopCode } };
  const res = createResponse();
  await handler(req, res);
  return res;
}

(async () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.SOFIA_TRANSPORT_API_URL;

  try {
    const now = new Date();
    const staticBoard = buildVirtualBoard({ routes: [], skipped_trips: [] }, '0605', now);
    const staticCourse = staticBoard.routes
      .flatMap(route => (route.times || []).map(time => ({ route, time })))
      .find(item => item.time?.scheduled === true && item.time?.trip_id);

    assert.ok(staticCourse, 'GTFS must contain an upcoming static course at stop 0605');

    const tripId = staticCourse.time.trip_id;
    const arrivalTimestamp = Number(staticCourse.time.timestamp) + 60;
    const arrivalDate = new Date(arrivalTimestamp * 1000).toISOString();
    const arrival = {
      id: `${tripId}-A0605-${arrivalTimestamp}`,
      routeShortName: staticCourse.route.route_ref,
      headsign: staticCourse.route.destination,
      arrivalDate,
      delaySeconds: 60
    };

    process.env.SOFIA_TRANSPORT_API_URL = 'https://sofia-api.example.test';
    let requestedUrl = '';
    global.fetch = async url => {
      requestedUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ stopCode: '0605', arrivals: [arrival], count: 1 })
      };
    };

    const realtimeResponse = await requestBoard('0605');
    assert.equal(realtimeResponse.statusCode, 200);
    assert.equal(realtimeResponse.payload.realtime_status, 'available');
    assert.equal(realtimeResponse.payload.realtime_source, 'sofia-transport-api');
    assert.equal(realtimeResponse.payload.realtime_matched_arrivals, 1);
    assert.equal(realtimeResponse.payload.realtime_feed_timestamp, null,
      'the upstream API does not expose the GTFS-RT FeedHeader timestamp');
    assert.equal(
      requestedUrl,
      'https://sofia-api.example.test/api/stops/0605/arrivals?limit=100',
      'GTSofia must query Sofia Transport API by public stop code'
    );

    const mappedTime = realtimeResponse.payload.routes
      .flatMap(route => (route.times || []).map(time => ({ route, time })))
      .find(item => item.time?.trip_id === tripId);
    assert.ok(mappedTime, 'the external arrival must map to its exact local GTFS trip');
    assert.equal(mappedTime.time.scheduled, false);
    assert.equal(mappedTime.time.source, 'realtime');
    assert.equal(mappedTime.time.timestamp, arrivalTimestamp);
    assert.equal(mappedTime.time.delay, 60);
    assert.equal(mappedTime.route.destination, staticCourse.route.destination,
      'the displayed destination must continue to come from local GTFS/OSM data');
    assert.ok(mappedTime.route.meta, 'local route display metadata must be preserved');

    // A mismatched source stop ID must not be assigned to this board, even if
    // its trip ID happens to exist in the local GTFS data.
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        arrivals: [{ ...arrival, id: `${tripId}-A9999-${arrivalTimestamp}` }],
        count: 1
      })
    });
    const unmatchedResponse = await requestBoard('0605');
    assert.equal(unmatchedResponse.statusCode, 200);
    assert.equal(unmatchedResponse.payload.realtime_matched_arrivals, 0);
    assert.equal(unmatchedResponse.payload.realtime_status, 'unavailable',
      'unmapped API results must be visible as a realtime integration problem');
    assert.ok(
      unmatchedResponse.payload.routes.every(route => route.times.every(time => time.scheduled === true)),
      'unmatched external arrivals must leave the local static timetable visible'
    );

    // Upstream failure must not take down the board: the static timetable and
    // OSM destinations remain available with a realtime warning.
    global.fetch = async () => { throw new Error('simulated upstream outage'); };
    const unavailableResponse = await requestBoard('0605');
    assert.equal(unavailableResponse.statusCode, 200);
    assert.equal(unavailableResponse.payload.realtime_status, 'unavailable');
    assert.match(unavailableResponse.payload.realtime_message, /показваме разписанието/i);
    assert.ok(Array.isArray(unavailableResponse.payload.routes));
    assert.ok(
      unavailableResponse.payload.routes.every(route => route.times.every(time => time.scheduled === true)),
      'upstream failure must fall back to the local timetable'
    );

    // Without a configured service URL, road-transport boards also remain
    // available as static boards and do not make a request to an unknown host.
    delete process.env.SOFIA_TRANSPORT_API_URL;
    let unconfiguredFetchCount = 0;
    global.fetch = async () => {
      unconfiguredFetchCount += 1;
      throw new Error('fetch must not run when the service URL is missing');
    };
    const unconfiguredResponse = await requestBoard('0605');
    assert.equal(unconfiguredResponse.statusCode, 200);
    assert.equal(unconfiguredResponse.payload.realtime_status, 'unavailable');
    assert.equal(unconfiguredFetchCount, 0);
    assert.ok(unconfiguredResponse.payload.routes.length > 0);

    // Metro must remain static-only and must not make any external request.
    process.env.SOFIA_TRANSPORT_API_URL = 'https://sofia-api.example.test';
    let metroFetchCount = 0;
    global.fetch = async () => {
      metroFetchCount += 1;
      throw new Error('metro must not call Sofia Transport API');
    };
    const metroResponse = await requestBoard('M1');
    assert.equal(metroResponse.statusCode, 200);
    assert.equal(metroResponse.payload.realtime_status, 'not_applicable');
    assert.equal(metroResponse.payload.realtime_source, 'static-gtfs');
    assert.equal(metroFetchCount, 0);
    assert.ok(metroResponse.payload.routes.length > 0, 'metro must keep its local static timetable');
    assert.ok(
      metroResponse.payload.routes.every(route => route.times.every(time => time.scheduled === true)),
      'metro arrivals must all remain schedule-based'
    );

    console.log('virtual-board-api: all tests passed');
  } finally {
    global.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.SOFIA_TRANSPORT_API_URL;
    else process.env.SOFIA_TRANSPORT_API_URL = originalApiUrl;
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
