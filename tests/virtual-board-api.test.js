const assert = require('node:assert/strict');
const handler = require('../api/virtual-board.js');
const routesData = require('../data/routes.json');

const tram22 = routesData.find(route => route.route_id === 'TM22');
assert.ok(tram22, 'local route metadata should contain tram 22');

const nowMs = Date.now();
const arrivalDate = new Date(nowMs + 5 * 60_000).toISOString();
const destinationTripId = 'TM22-TM4-9-13-17666667941';

const mapped = handler.mapRealtimeArrivalsToBoard([
  {
    id: 'trip-22-1',
    tripId: 'trip-22-1',
    routeId: 'TM22',
    routeShortName: '22',
    routeType: '0',
    headsign: 'Автостанция Изток',
    arrivalDate,
    delaySeconds: 90,
    isRealtime: true
  },
  {
    id: 'static-arrival',
    routeId: 'TM22',
    routeShortName: '22',
    headsign: 'Автостанция Изток',
    arrivalDate: new Date(nowMs + 6 * 60_000).toISOString(),
    isRealtime: false
  },
  {
    id: 'past-arrival',
    routeId: 'TM22',
    routeShortName: '22',
    headsign: 'Автостанция Изток',
    arrivalDate: new Date(nowMs - 2 * 60_000).toISOString(),
    isRealtime: true
  },
  {
    id: 'no-time',
    routeId: 'TM22',
    routeShortName: '22',
    headsign: 'Автостанция Изток',
    isRealtime: true
  }
,
  {
    id: 'unmarked-time',
    routeId: 'TM22',
    routeShortName: '22',
    headsign: 'Автостанция Изток',
    arrivalDate: new Date(nowMs + 7 * 60_000).toISOString()
  }
], { nowMs });

assert.equal(mapped.length, 1);
assert.equal(mapped[0].route_id, 'TM22');
assert.equal(mapped[0].destination, 'Автостанция Изток');
assert.equal(mapped[0].meta.number, '22');
assert.equal(mapped[0].meta.type, 'tram');
assert.equal(mapped[0].times.length, 1);
assert.equal(mapped[0].times[0].source, 'realtime');
assert.equal(mapped[0].times[0].scheduled, false);
assert.equal(mapped[0].times[0].delay, 90);


const scheduledMapped = handler.mapRealtimeArrivalsToBoard([{
  id: 'scheduled-trip-22',
  tripId: destinationTripId,
  routeId: 'TM22',
  routeShortName: '22',
  routeType: '0',
  headsign: 'Автостанция Изток',
  destination: 'Автостанция Изток',
  terminalStopId: '2023',
  arrivalDate,
  isRealtime: false,
  isScheduled: true,
  source: 'schedule'
}], { nowMs, stopIdentifier: '1247' });
assert.equal(scheduledMapped.length, 1, 'surface timetable fallback rows are accepted by the board mapper');
assert.equal(scheduledMapped[0].times[0].source, 'schedule');
assert.equal(scheduledMapped[0].times[0].scheduled, true);
assert.equal(scheduledMapped[0].times[0].realtime, false);
const scheduledAtTerminal = handler.mapRealtimeArrivalsToBoard([{
  id: 'scheduled-trip-22-terminal',
  tripId: destinationTripId,
  routeId: 'TM22',
  routeShortName: '22',
  routeType: '0',
  headsign: 'Автостанция Изток',
  destination: 'Автостанция Изток',
  terminalStopId: '2023',
  arrivalDate,
  isScheduled: true,
  source: 'schedule'
}], { nowMs, stopIdentifier: '2023' });
assert.deepEqual(scheduledAtTerminal, [], 'the full terminal-course filter also removes schedule fallback arrivals');

const scheduledPartialAtTerminal = handler.mapRealtimeArrivalsToBoard([{
  id: 'scheduled-partial-at-terminal',
  tripId: 'scheduled-partial-course',
  routeId: 'TM22',
  routeShortName: '22',
  routeType: '0',
  headsign: 'гара Подуяне',
  destination: 'гара Подуяне',
  terminalStopId: '0470',
  arrivalDate,
  isScheduled: true,
  source: 'schedule'
}], { nowMs, stopIdentifier: '0470' });
assert.deepEqual(scheduledPartialAtTerminal, [],
  'a static fallback partial course ending at the open surface stop is omitted completely');

const destinationArrival = {
  id: 'osm-destination-test',
  tripId: destinationTripId,
  routeId: 'TM22',
  routeShortName: '22',
  routeType: '0',
  headsign: 'Автостанция Изток',
  arrivalDate,
  isRealtime: true
};
const osmDestination = handler.mapRealtimeArrivalsToBoard([destinationArrival], {
  nowMs,
  stopIdentifier: '1247'
});
assert.equal(osmDestination[0].destination, 'Автостанция Изток', 'the direction endpoint should use the OSM-first terminal-stop name');

// If a GTFS RT headsign has formatting or wording that does not exactly match
// an OSM stop name, use the per-trip OSM-first destination map instead of
// returning the raw GTFS text to the virtual board.
const gtfsHeadsignFallsBackToOsm = handler.mapRealtimeArrivalsToBoard([{
  ...destinationArrival,
  id: 'gtfs-headsign-osm-fallback',
  tripId: 'gtfs-headsign-osm-fallback-trip',
  headsign: 'АВТОСТАНЦИЯ ИЗТОК (ГТФС ВАРИАНТ)'
}], {
  nowMs,
  stopIdentifier: '1247',
  stops: [
    { stop_id: '1247', stop_code: '1247', stop_name: 'Парк', osm_stop_name: 'Парк' },
    { stop_id: '2023', stop_code: '2023', stop_name: 'Автостанция Изток', osm_stop_name: 'Автостанция Изток' }
  ],
  tripDestinations: {
    'gtfs-headsign-osm-fallback-trip': {
      terminal_stop_id: '2023',
      destination: 'Автостанция Изток'
    }
  }
});
assert.equal(gtfsHeadsignFallsBackToOsm[0].destination, 'Автостанция Изток',
  'an unmatched GTFS headsign must fall back to the OSM-first per-trip destination');
assert.equal(handler.resolveOsmDestinationName('NOT A KNOWN STOP', []), '',
  'the OSM resolver must not masquerade an unmatched GTFS value as an OSM name');
const hiddenTerminal = handler.mapRealtimeArrivalsToBoard([destinationArrival], {
  nowMs,
  stopIdentifier: '2023'
});
assert.deepEqual(hiddenTerminal, [], 'a course ending at the open board stop is omitted completely, including all arrival times');

// Short-turn / partial courses use their own per-trip terminal mapping. When
// that terminal is the station currently open, the direction must be hidden.
const partialTripId = 'TM22-partial-to-poduyane';
const partialCourse = handler.mapRealtimeArrivalsToBoard([{
  ...destinationArrival,
  id: 'partial-course-terminal-test',
  tripId: partialTripId,
  headsign: ''
}], {
  nowMs,
  stopIdentifier: '0470',
  tripDestinations: {
    [partialTripId]: {
      terminal_stop_id: '0470',
      destination: 'гара Подуяне'
    }
  }
});
assert.deepEqual(partialCourse, [], 'a partial course ending at the open board stop is omitted completely');

const partialHeadSignOverridesFullRoute = handler.mapRealtimeArrivalsToBoard([{
  ...destinationArrival,
  id: 'partial-course-headsign-overrides-static-terminal',
  tripId: 'partial-course-with-static-full-route-map',
  headsign: 'ГАРА ПОДУЯНЕ'
}], {
  nowMs,
  stopIdentifier: '0470',
  tripDestinations: {
    'partial-course-with-static-full-route-map': {
      terminal_stop_id: '2023',
      destination: 'Автостанция Изток'
    }
  }
});
assert.deepEqual(partialHeadSignOverridesFullRoute, [], 'an RT partial-course headsign can identify and completely omit a short-turn at the open board stop');

const partialHeadSignOverridesStaticTerminalAtFullEndpoint = handler.mapRealtimeArrivalsToBoard([{
  ...destinationArrival,
  id: 'partial-course-continues-past-static-terminal',
  tripId: 'partial-course-with-static-full-route-map',
  headsign: 'ГАРА ПОДУЯНЕ'
}], {
  nowMs,
  stopIdentifier: '2023',
  tripDestinations: {
    'partial-course-with-static-full-route-map': {
      terminal_stop_id: '2023',
      destination: 'Автостанция Изток'
    }
  }
});
assert.equal(partialHeadSignOverridesStaticTerminalAtFullEndpoint.length, 1,
  'an RT partial-course headsign overrides the static full-route terminal when deciding whether the open stop is the actual endpoint');

// A partial course may be absent from the per-trip destination table. In that
// case an RT headsign matching the current stop name still identifies it.
const partialHeadsignCourse = handler.mapRealtimeArrivalsToBoard([{
  ...destinationArrival,
  id: 'partial-headsign-terminal-test',
  tripId: 'unmapped-partial-course',
  headsign: 'ГАРА ПОДУЯНЕ'
}], {
  nowMs,
  stopIdentifier: '0470'
});
assert.deepEqual(partialHeadsignCourse, [], 'a partial-course headsign matching the OSM/GTFS stop name omits the complete arrival');

// Filtering is per trip, not per route: a terminal trip is omitted while a
// different trip on the same line can remain visible if it continues beyond
// this board stop.
const mixedTerminalAndThroughTrips = handler.mapRealtimeArrivalsToBoard([
  destinationArrival,
  {
    ...destinationArrival,
    id: 'same-line-through-trip',
    tripId: 'same-line-through-trip',
    headsign: 'Депо Искър'
  }
], {
  nowMs,
  stopIdentifier: '2023'
});
assert.equal(mixedTerminalAndThroughTrips.length, 1);
assert.equal(mixedTerminalAndThroughTrips[0].times.length, 1);
assert.equal(mixedTerminalAndThroughTrips[0].times[0].trip_id, 'same-line-through-trip',
  'only the trip that terminates at the board stop is omitted; a through trip on the same line remains');

const metroRealtime = handler.mapRealtimeArrivalsToBoard([{
  id: 'metro-rt-test',
  tripId: 'metro-rt-test',
  routeId: 'M1',
  routeShortName: '1',
  routeType: '1',
  headsign: 'Бизнес парк София',
  arrivalDate,
  isRealtime: true
}], { nowMs, stopIdentifier: 'M1' });
assert.deepEqual(metroRealtime, [], 'metro is served from its labelled timetable, not the RT adapter');

const testMetroData = {
  calendar: { dateTypes: { '2026-11-13': 'weekday' }, dateOverrides: {} },
  routes: {
    M1: {
      route_id: 'M1',
      route_short_name: '1',
      route_type: '1',
      route_color: '1C75BC',
      route_text_color: 'FFFFFF',
      directions: {
        D1: {
          destination: 'Бизнес парк София',
          terminal_stop_id: 'M2',
          stop_ids: ['M1', 'M2'],
          weekday: [{ original_trip_id: 'metro-course-1', times: ['07:05:00', '07:07:00'] }],
          weekend: []
        }
      }
    }
  }
};
const fixedMetroNow = Date.parse('2026-11-13T05:00:00.000Z'); // 07:00 in Sofia
const metroStartBoard = handler.buildMetroScheduleRoutes('M1', {
  nowMs: fixedMetroNow,
  metroData: testMetroData,
  stops: [{ stop_id: 'M1', stop_code: '1' }, { stop_id: 'M2', stop_code: '2' }]
});
assert.equal(metroStartBoard.isMetroStation, true);
assert.equal(metroStartBoard.routes[0].meta.type, 'metro');
assert.equal(metroStartBoard.routes[0].destination, 'Бизнес парк София');
assert.equal(metroStartBoard.routes[0].times[0].source, 'schedule');
assert.equal(metroStartBoard.routes[0].times[0].scheduled, true);
assert.equal(metroStartBoard.routes[0].times[0].timestamp, Math.floor(Date.parse('2026-11-13T05:05:00.000Z') / 1000));
const metroTerminalBoard = handler.buildMetroScheduleRoutes('M2', {
  nowMs: fixedMetroNow,
  metroData: testMetroData,
  stops: [{ stop_id: 'M1', stop_code: '1' }, { stop_id: 'M2', stop_code: '2' }]
});
assert.deepEqual(metroTerminalBoard.routes, [],
  'the complete static metro direction and all its scheduled times are omitted when the open station is its terminal');

const metroTerminalWithoutExplicitTerminalId = handler.buildMetroScheduleRoutes('M2', {
  nowMs: fixedMetroNow,
  metroData: {
    calendar: testMetroData.calendar,
    routes: {
      M1: {
        route_id: 'M1', route_short_name: '1', route_type: '1',
        directions: {
          D1: {
            destination: 'Автостанция',
            stop_ids: ['M1', 'M2'],
            weekday: [{ original_trip_id: 'terminal-without-id', times: ['07:05:00', '07:07:00'] }],
            weekend: []
          }
        }
      }
    }
  },
  stops: [{ stop_id: 'M1', stop_code: '1' }, { stop_id: 'M2', stop_code: '2' }]
});
assert.deepEqual(metroTerminalWithoutExplicitTerminalId.routes, [],
  'the last stop ID is used as the terminal when terminal_stop_id is absent');

// At a station that terminates one direction but is an intermediate stop in
// the opposite direction, only the terminating direction must be hidden.
const metroTwoWayData = {
  calendar: testMetroData.calendar,
  routes: {
    M1: {
      ...testMetroData.routes.M1,
      directions: {
        ...testMetroData.routes.M1.directions,
        D2: {
          destination: 'Сливница',
          terminal_stop_id: 'M3',
          stop_ids: ['M2', 'M1', 'M3'],
          weekday: [{ original_trip_id: 'metro-course-through', times: ['07:04:00', '07:06:00', '07:09:00'] }],
          weekend: []
        }
      }
    }
  }
};
const metroMixedDirections = handler.buildMetroScheduleRoutes('M2', {
  nowMs: fixedMetroNow,
  metroData: metroTwoWayData,
  stops: [{ stop_id: 'M1', stop_code: '1' }, { stop_id: 'M2', stop_code: '2' }, { stop_id: 'M3', stop_code: '3' }]
});
assert.equal(metroMixedDirections.routes.length, 1,
  'only the metro direction that terminates at the open station is omitted');
assert.equal(metroMixedDirections.routes[0].destination, 'Сливница');
assert.equal(metroMixedDirections.routes[0].times[0].trip_id, 'metro-course-through');

function makeResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; }
  };
}

(async () => {
  const originalFetch = global.fetch;
  const originalProxyUrl = process.env.SOFIA_REALTIME_PROXY_URL;

  try {
    process.env.SOFIA_REALTIME_PROXY_URL = 'https://proxy.example';
    let requestedUrl = '';
    global.fetch = async url => {
      requestedUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          feedTimestamp: Math.floor(Date.now() / 1000),
          realtimeCount: 1,
          scheduledCount: 2,
          scheduledCandidateCount: 4,
          scheduledMergedCount: 3,
          scheduleGeneratedAt: '2026-11-13',
          arrivals: [{
            id: 'live-trip-22',
            tripId: 'live-trip-22',
            routeId: 'TM22',
            routeShortName: '22',
            routeType: '0',
            headsign: 'Автостанция Изток',
            arrivalDate,
            delaySeconds: 45,
            isRealtime: true
          }]
        })
      };
    };

    let res = makeResponse();
    await handler({ method: 'GET', query: { stop_code: '1247' } }, res);
    assert.equal(res.statusCode, 200);
    assert.match(requestedUrl, /\/api\/stops\/1247\/arrivals\?limit=100$/);
    assert.equal(res.body.realtime_only, undefined, 'the legacy realtime-only response flag is no longer needed');
    assert.equal(res.body.board_mode, 'realtime-with-schedule-fallback');
    assert.equal(res.body.realtime_status, 'available');
    assert.equal(res.body.routes.length, 1);
    assert.equal(res.body.routes[0].times[0].source, 'realtime');
    assert.equal(res.body.routes[0].times[0].scheduled, false);
    assert.equal(res.body.scheduled_count, 2);
    assert.equal(res.body.scheduled_candidate_count, 4);
    assert.equal(res.body.scheduled_merged_count, 3);
    assert.equal(res.body.schedule_generated_at, '2026-11-13');

    // Metro stations are served from the local official timetable; they do not
    // make an RT request to Render.
    const urlBeforeMetro = requestedUrl;
    res = makeResponse();
    await handler({ method: 'GET', query: { stop_id: 'M1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.board_mode, 'metro-schedule');
    assert.equal(res.body.realtime_status, 'not_applicable');
    assert.equal(res.body.realtime_message, undefined, 'metro board response does not send a realtime disclaimer');
    assert.ok(res.body.routes.every(route => route.meta.type === 'metro'));
    assert.ok(res.body.routes.every(route => route.times.every(time => time.source === 'schedule')));
    assert.equal(requestedUrl, urlBeforeMetro, 'metro board must not call the realtime proxy');

    // The Vercel mapper does not independently invent timetable rows; the proxy owns the RT/schedule merge.
    global.fetch = async () => ({ ok: true, json: async () => ({ arrivals: [], feedTimestamp: Math.floor(Date.now() / 1000) }) });
    res = makeResponse();
    await handler({ method: 'GET', query: { stop_code: '1247' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'empty');
    assert.deepEqual(res.body.routes, []);

    // If the proxy itself is unreachable, Vercel cannot reach the proxy-owned schedule index either.
    global.fetch = async () => ({ ok: false, status: 503, text: async () => 'offline' });
    res = makeResponse();
    await handler({ method: 'GET', query: { stop_code: '1247' } }, res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.realtime_status, 'unavailable');
    assert.deepEqual(res.body.routes, []);

    // Missing proxy configuration means the proxy-owned timetable index is unreachable too.
    delete process.env.SOFIA_REALTIME_PROXY_URL;
    res = makeResponse();
    await handler({ method: 'GET', query: { stop_code: '1247' } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.realtime_status, 'unavailable');
    assert.deepEqual(res.body.routes, []);
  } finally {
    global.fetch = originalFetch;
    if (originalProxyUrl === undefined) delete process.env.SOFIA_REALTIME_PROXY_URL;
    else process.env.SOFIA_REALTIME_PROXY_URL = originalProxyUrl;
  }

  console.log('Virtual-board realtime proxy tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
