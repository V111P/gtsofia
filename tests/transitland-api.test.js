'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

function createResponseRecorder() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('virtual-board API uses Transitland when enabled and keeps the API key server-side', async () => {
  const oldProvider = process.env.VIRTUAL_BOARD_PROVIDER;
  const oldKey = process.env.TRANSITLAND_API_KEY;
  const oldFetch = globalThis.fetch;
  const handlerPath = require.resolve('../api/virtual-board');
  const servicePath = require.resolve('../api/transitland-service');
  let requestUrl = '';
  let requestHeaders = null;

  try {
    process.env.VIRTUAL_BOARD_PROVIDER = 'transitland';
    process.env.TRANSITLAND_API_KEY = 'integration-test-key';
    globalThis.fetch = async (url, options) => {
      requestUrl = url;
      requestHeaders = options.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ stops: [{ stop_id: 'M202', departures: [] }] })
      };
    };
    delete require.cache[servicePath];
    delete require.cache[handlerPath];
    const handler = require('../api/virtual-board');
    const response = createResponseRecorder();

    await handler({ method: 'GET', query: { stop_code: 'M202' } }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.provider, 'transitland');
    assert.equal(response.body.realtime_status, 'not_applicable');
    assert.equal(response.body.stop_code, 'M202');
    assert.match(requestUrl, /\/stops\/f-sofiatraffic~bg%3AM202\/departures/);
    assert.equal(requestHeaders.apikey, 'integration-test-key');
    assert.equal(JSON.stringify(response.body).includes('integration-test-key'), false);
  } finally {
    if (oldProvider === undefined) delete process.env.VIRTUAL_BOARD_PROVIDER;
    else process.env.VIRTUAL_BOARD_PROVIDER = oldProvider;
    if (oldKey === undefined) delete process.env.TRANSITLAND_API_KEY;
    else process.env.TRANSITLAND_API_KEY = oldKey;
    globalThis.fetch = oldFetch;
    delete require.cache[servicePath];
    delete require.cache[handlerPath];
  }
});

test('falls back to the existing implementation when Transitland is unavailable', async () => {
  const oldProvider = process.env.VIRTUAL_BOARD_PROVIDER;
  const oldKey = process.env.TRANSITLAND_API_KEY;
  const oldFetch = globalThis.fetch;
  const handlerPath = require.resolve('../api/virtual-board');
  const servicePath = require.resolve('../api/transitland-service');

  try {
    process.env.VIRTUAL_BOARD_PROVIDER = 'transitland';
    process.env.TRANSITLAND_API_KEY = 'integration-test-key';
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'simulated upstream outage'
    });
    delete require.cache[servicePath];
    delete require.cache[handlerPath];
    const handler = require('../api/virtual-board');
    const response = createResponseRecorder();

    await handler({ method: 'GET', query: { stop_code: '0605' } }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.provider, 'legacy');
    assert.equal(response.body.realtime_status, 'unavailable');
    assert.ok(Array.isArray(response.body.routes));
  } finally {
    if (oldProvider === undefined) delete process.env.VIRTUAL_BOARD_PROVIDER;
    else process.env.VIRTUAL_BOARD_PROVIDER = oldProvider;
    if (oldKey === undefined) delete process.env.TRANSITLAND_API_KEY;
    else process.env.TRANSITLAND_API_KEY = oldKey;
    globalThis.fetch = oldFetch;
    delete require.cache[servicePath];
    delete require.cache[handlerPath];
  }
});
