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
    assert.equal(res.body.realtime_only, true);
    assert.deepEqual(res.body.routes, [], 'an unavailable realtime source must not create schedule rows');
    assert.match(res.body.realtime_message, /Не показваме времена от разписанието/i);
  } finally {
    global.fetch = originalFetch;
    if (originalProxyUrl === undefined) delete process.env.SOFIA_REALTIME_PROXY_URL;
    else process.env.SOFIA_REALTIME_PROXY_URL = originalProxyUrl;
  }

  console.log('virtual-board-protobuf: realtime-only outage behaviour passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
