'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const routes = require('../data/routes.json');
const directions = require('../data/directions.json');
const schedules = require('../data/schedules.json');
const stops = require('../data/stops.json');
const {
  createTransitlandService,
  buildTransitlandBoard,
  parseLocalDateTimeToEpochSeconds,
  parseHmsToEpochSeconds
} = require('../api/transitland-service');

function findFixture({ metro = false, stopId = null, from = '10:00:00', to = '12:00:00' } = {}) {
  const routeById = new Map(routes.map(route => [String(route.route_id), route]));
  const stopIds = new Set(stops.map(stop => String(stop.stop_id)));
  for (const [routeId, routeDirections] of Object.entries(schedules)) {
    const route = routeById.get(routeId);
    if (!route) continue;
    const routeIsMetro = String(route.route_type) === '1';
    if (routeIsMetro !== metro) continue;
    for (const [directionKey, daySchedules] of Object.entries(routeDirections)) {
      const direction = directions?.[routeId]?.[directionKey];
      const pattern = direction?.pattern || [];
      for (const dayType of ['weekday', 'weekend']) {
        for (const schedule of daySchedules?.[dayType] || []) {
          for (let index = 0; index < Math.min(pattern.length, schedule.times.length); index += 1) {
            const time = String(schedule.times[index] || '');
            if (!time || time < from || time > to) continue;
            const candidateStopId = String(pattern[index] || '');
            if (!stopIds.has(candidateStopId)) continue;
            if (stopId && candidateStopId !== stopId) continue;
            return { route, routeId, direction, directionKey, schedule, stopId: candidateStopId, index, dayType };
          }
        }
      }
    }
  }
  throw new Error(`No GTFS fixture found for metro=${metro}, stopId=${stopId || 'any'}.`);
}

function transitlandDeparture(fixture, overrides = {}) {
  const scheduledLocal = overrides.scheduledLocal || '2026-11-14T10:00:00';
  const scheduledUtc = overrides.scheduledUtc || '2026-11-14T08:00:00Z';
  const arrival = {
    scheduled_local: scheduledLocal,
    scheduled_utc: scheduledUtc
  };
  if (overrides.estimatedLocal) arrival.estimated_local = overrides.estimatedLocal;
  if (overrides.estimatedUtc) arrival.estimated_utc = overrides.estimatedUtc;
  if (overrides.estimatedDelay !== undefined) arrival.estimated_delay = overrides.estimatedDelay;

  return {
    date: overrides.date || '2026-11-14',
    service_date: overrides.serviceDate || '2026-11-14',
    schedule_relationship: overrides.relationship || (overrides.estimatedUtc ? 'SCHEDULED' : 'STATIC'),
    stop_sequence: fixture.index + 1,
    arrival,
    trip: {
      trip_id: fixture.schedule.original_trip_id,
      trip_headsign: fixture.direction.headsign,
      direction_id: fixture.direction.direction_id,
      timestamp: overrides.tripTimestamp || null,
      schedule_relationship: overrides.relationship || (overrides.estimatedUtc ? 'SCHEDULED' : 'STATIC'),
      route: {
        route_id: fixture.routeId,
        route_short_name: fixture.route.route_short_name,
        route_long_name: fixture.route.route_long_name,
        route_type: Number(fixture.route.route_type),
        route_color: fixture.route.route_color,
        route_text_color: fixture.route.route_text_color
      }
    }
  };
}

function responseFor(fixture, departures) {
  return {
    stops: [{
      stop_id: fixture.stopId,
      stop_code: fixture.stopId,
      stop_name: fixture.stopId,
      departures
    }]
  };
}

const roadFixture = findFixture({ metro: false });
const metroFixture = findFixture({ metro: true, stopId: 'M202', from: '24:00:00', to: '24:59:59' });

// 14 November 2026, 09:55 in Sofia (UTC+02:00).
const roadNow = new Date('2026-11-14T07:55:00Z');

test('parses Sofia wall-clock timestamps and GTFS times over 24 hours', () => {
  assert.equal(
    parseLocalDateTimeToEpochSeconds('2026-11-14T10:00:00'),
    Date.parse('2026-11-14T08:00:00Z') / 1000
  );
  assert.equal(
    parseHmsToEpochSeconds('2026-11-15', '24:33:00'),
    Date.parse('2026-11-15T22:33:00Z') / 1000
  );
});

test('uses Transitland realtime estimate for road transport and preserves local line metadata', () => {
  const response = responseFor(roadFixture, [transitlandDeparture(roadFixture, {
    scheduledLocal: '2026-11-14T10:00:00',
    scheduledUtc: '2026-11-14T08:00:00Z',
    estimatedLocal: '2026-11-14T10:02:00',
    estimatedUtc: '2026-11-14T08:02:00Z',
    estimatedDelay: 120,
    relationship: 'SCHEDULED',
    tripTimestamp: '2026-11-14T07:54:00Z'
  })]);

  const stop = stops.find(item => item.stop_id === roadFixture.stopId);
  const board = buildTransitlandBoard(response, stop, roadNow);
  assert.equal(board.provider, 'transitland');
  assert.equal(board.realtime_status, 'available');
  assert.equal(board.status, 'ok');
  assert.equal(board.routes.length, 1);
  assert.equal(board.routes[0].route_id, roadFixture.routeId);
  assert.equal(board.routes[0].meta.number, roadFixture.route.route_short_name);
  assert.equal(board.routes[0].times[0].scheduled, false);
  assert.equal(board.routes[0].times[0].timestamp, Date.parse('2026-11-14T08:02:00Z') / 1000);
  assert.equal(board.routes[0].times[0].delay, 120);
  assert.equal(board.realtime_courses.length, 1);
});

test('uses the scheduled metro time even when Transitland includes an estimate', () => {
  const response = responseFor(metroFixture, [transitlandDeparture(metroFixture, {
    scheduledLocal: '2026-11-14T10:00:00',
    scheduledUtc: '2026-11-14T08:00:00Z',
    estimatedLocal: '2026-11-14T10:05:00',
    estimatedUtc: '2026-11-14T08:05:00Z',
    estimatedDelay: 300,
    relationship: 'SCHEDULED'
  })]);
  const stop = stops.find(item => item.stop_id === metroFixture.stopId);
  const board = buildTransitlandBoard(response, stop, roadNow);

  assert.equal(board.realtime_status, 'not_applicable');
  assert.equal(board.realtime_feed_timestamp, null);
  assert.equal(board.routes[0].times[0].scheduled, true);
  assert.equal(board.routes[0].times[0].timestamp, Date.parse('2026-11-14T08:00:00Z') / 1000);
});

test('keeps previous-service-day metro courses after midnight using calendar date timestamps', () => {
  const tripId = 'M2-M2_1-5-579-2026-09-25-1_1-6006067750';
  const fixture = {
    routeId: 'M2',
    stopId: 'M202',
    route: routes.find(route => route.route_id === 'M2'),
    direction: directions.M2.D2,
    directionKey: 'D2',
    schedule: schedules.M2.D2.weekend.find(row => row.original_trip_id === tripId),
    index: directions.M2.D2.pattern.indexOf('M202')
  };
  assert.ok(fixture.schedule, 'fixture must exist in the Sunday GTFS schedule');

  const afterMidnightNow = new Date('2026-11-15T22:25:00Z'); // Monday 00:25 in Sofia.
  const response = responseFor(fixture, [transitlandDeparture(fixture, {
    scheduledLocal: '2026-11-16T00:33:00',
    scheduledUtc: '2026-11-15T22:33:00Z',
    date: '2026-11-16',
    serviceDate: '2026-11-15',
    relationship: 'STATIC'
  })]);
  const stop = stops.find(item => item.stop_id === 'M202');
  const board = buildTransitlandBoard(response, stop, afterMidnightNow);

  assert.equal(board.status, 'ok');
  assert.equal(board.routes[0].times[0].timestamp, Date.parse('2026-11-15T22:33:00Z') / 1000);
  assert.equal(board.routes[0].times[0].trip_start_date, '20261115');
  assert.equal(board.routes[0].times[0].scheduled, true);
});

test('does not display canceled, deleted or skipped departures', () => {
  const response = responseFor(roadFixture, [
    transitlandDeparture(roadFixture, { relationship: 'CANCELED' }),
    transitlandDeparture(roadFixture, { relationship: 'DELETED' }),
    transitlandDeparture(roadFixture, { relationship: 'SKIPPED' })
  ]);
  const stop = stops.find(item => item.stop_id === roadFixture.stopId);
  const board = buildTransitlandBoard(response, stop, roadNow);
  assert.equal(board.status, 'empty');
  assert.equal(board.routes.length, 0);
});

test('requests a feed-scoped stop with API key and caches repeated queries', async () => {
  let requestCount = 0;
  let requestUrl = '';
  let requestOptions = null;
  const response = responseFor(roadFixture, [transitlandDeparture(roadFixture, {
    scheduledLocal: '2026-11-14T10:00:00',
    scheduledUtc: '2026-11-14T08:00:00Z'
  })]);
  const service = createTransitlandService({
    apiKey: 'test-key-not-a-real-secret',
    cacheTtlMs: 60_000,
    fetchImpl: async (url, options) => {
      requestCount += 1;
      requestUrl = url;
      requestOptions = options;
      return { ok: true, status: 200, json: async () => response };
    }
  });
  const stop = stops.find(item => item.stop_id === roadFixture.stopId);
  await service.getBoard(stop.stop_id, roadNow);
  await service.getBoard(stop.stop_id, roadNow);

  assert.equal(requestCount, 1);
  assert.match(requestUrl, /\/stops\/f-sofiatraffic~bg%3A/);
  assert.equal(new URL(requestUrl).searchParams.get('date'), '2026-11-14');
  assert.equal(new URL(requestUrl).searchParams.get('next'), '7200');
  assert.equal(requestOptions.headers.apikey, 'test-key-not-a-real-secret');
});

test('fails clearly when the Transitland key is missing', async () => {
  const service = createTransitlandService({ apiKey: '', fetchImpl: async () => { throw new Error('Should not fetch'); } });
  await assert.rejects(() => service.getBoard(roadFixture.stopId, roadNow), /TRANSITLAND_API_KEY is not configured/);
});

test('requests a longer, infrequently cached window for metro timetables', async () => {
  let requestCount = 0;
  let requestUrl = '';
  const response = { stops: [{ stop_id: 'M202', departures: [] }] };
  const service = createTransitlandService({
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl: async (url) => {
      requestCount += 1;
      requestUrl = url;
      return { ok: true, status: 200, json: async () => response };
    }
  });

  await service.getBoard('M202', roadNow);
  await service.getBoard('M202', roadNow);
  assert.equal(requestCount, 1);
  assert.equal(new URL(requestUrl).searchParams.get('next'), '14400');
});
