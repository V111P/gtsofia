const assert = require('node:assert/strict');
const handler = require('../api/virtual-board.js');

function varint(value) {
  let n = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function field(number, wireType, value) {
  const tag = varint((number << 3) | wireType);
  if (wireType === 0) return Buffer.concat([tag, value]);
  if (wireType === 2) return Buffer.concat([tag, varint(value.length), value]);
  throw new Error(`Unsupported wire type ${wireType}`);
}

function makeFullFeed(timestamp = Math.floor(Date.now() / 1000)) {
  const header = Buffer.concat([
    field(1, 2, Buffer.from('2.0')),
    field(3, 0, varint(timestamp)),
  ]);
  return field(1, 2, header);
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function binaryResponse(buffer, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

const req = { method: 'GET', query: { stop_code: '0605' } };
let payload;
const res = {
  status(code) { this.statusCode = code; return this; },
  json(value) { payload = value; return this; },
  setHeader() {},
};

(async () => {
  const priorUrl = process.env.SOFIA_TRANSPORT_API_URL;
  const priorKey = process.env.SOFIA_TRANSPORT_PROXY_API_KEY;
  process.env.SOFIA_TRANSPORT_API_URL = 'https://proxy.example.test';
  process.env.SOFIA_TRANSPORT_PROXY_API_KEY = 'test-proxy-key';

  const timestamp = Math.floor(Date.now() / 1000);
  let proxyHeaders;
  global.fetch = async (url, options = {}) => {
    assert.equal(url, 'https://proxy.example.test/api/trip-updates');
    proxyHeaders = options.headers;
    return jsonResponse({ feedTimestamp: timestamp, feedIncrementality: 0, tripUpdates: [] });
  };

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.provider, 'sofia-transport-api');
  assert.equal(payload.realtime_status, 'available');
  assert.equal(proxyHeaders.Authorization, 'Bearer test-proxy-key');

  // If the JSON proxy is unavailable, the original direct decoder must still
  // supply realtime data and the response must identify that fallback.
  let calls = 0;
  const fallbackFeed = makeFullFeed();
  global.fetch = async (url) => {
    calls += 1;
    if (String(url).endsWith('/api/trip-updates')) return jsonResponse({ error: 'offline' }, 503);
    return binaryResponse(fallbackFeed);
  };

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.provider, 'legacy');
  assert.equal(payload.realtime_status, 'available');
  assert.match(payload.realtime_message, /proxy.*недостъпен/i);
  assert.equal(calls, 2, 'proxy failure must trigger exactly one legacy fallback request');

  // Metro remains schedule-only and never calls either provider.
  let metroCalls = 0;
  global.fetch = async () => { metroCalls += 1; throw new Error('should not fetch realtime for metro'); };
  req.query.stop_code = 'M1';
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.provider, 'schedule');
  assert.equal(payload.realtime_status, 'not_applicable');
  assert.equal(metroCalls, 0);

  if (priorUrl === undefined) delete process.env.SOFIA_TRANSPORT_API_URL;
  else process.env.SOFIA_TRANSPORT_API_URL = priorUrl;
  if (priorKey === undefined) delete process.env.SOFIA_TRANSPORT_PROXY_API_KEY;
  else process.env.SOFIA_TRANSPORT_PROXY_API_KEY = priorKey;

  console.log('virtual-board-proxy: all tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
