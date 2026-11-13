const assert = require('node:assert/strict');
const handler = require('../api/virtual-board.js');

function makeResponse() {
  return {
    statusCode: null,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

(async () => {
  const originalFetch = global.fetch;
  const originalProxyUrl = process.env.SOFIA_REALTIME_PROXY_URL;

  try {
    process.env.SOFIA_REALTIME_PROXY_URL = 'https://proxy.example';
    global.fetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'upstream temporarily unavailable'
    });

    const res = makeResponse();
    await handler({ method: 'GET', query: { stop_code: '0605' } }, res);

    assert.equal(res.statusCode, 502);
    assert.equal(res.body.realtime_status, 'unavailable');
    assert.equal(res.body.realtime_only, undefined, 'the API no longer advertises the removed realtime-only mode');
    assert.deepEqual(res.body.routes, [], 'if Render itself is unavailable, Vercel cannot serve the timetable index hosted on Render');
    assert.match(res.body.realtime_message, /резервното разписание временно не са налични/i);
  } finally {
    global.fetch = originalFetch;
    if (originalProxyUrl === undefined) delete process.env.SOFIA_REALTIME_PROXY_URL;
    else process.env.SOFIA_REALTIME_PROXY_URL = originalProxyUrl;
  }

  console.log('virtual-board-protobuf: proxy outage behaviour passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
