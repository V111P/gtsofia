const assert = require('node:assert/strict');
const handler = require('../api/virtual-board.js');

function varint(value) {
  let number = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  while (number >= 0x80n) {
    bytes.push(Number((number & 0x7fn) | 0x80n));
    number >>= 7n;
  }
  bytes.push(Number(number));
  return Buffer.from(bytes);
}

function field(number, wireType, value) {
  const tag = varint((number << 3) | wireType);
  if (wireType === 0) return Buffer.concat([tag, value]);
  if (wireType === 2) return Buffer.concat([tag, varint(value.length), value]);
  throw new Error(`Unsupported test wire type ${wireType}`);
}

let feed = Buffer.from([0x80]); // truncated varint tag

global.fetch = async () => ({
  ok: true,
  arrayBuffer: async () => feed.buffer.slice(feed.byteOffset, feed.byteOffset + feed.byteLength)
});

const req = { method: 'GET', query: { stop_code: '0605' } };
const res = {
  status(code) { this.statusCode = code; return this; },
  json(value) { this.payload = value; return this; },
  setHeader() {}
};

(async () => {
  await handler(req, res);
  assert.equal(res.statusCode, 502, 'a malformed protobuf feed must fail closed');
  assert.match(res.payload.error, /protobuf varint/i);

  // The stateless board service cannot reconstruct a DIFFERENTIAL feed because
  // it does not retain an upstream entity state between snapshots.
  const header = Buffer.concat([
    field(2, 0, varint(1)), // FeedHeader.incrementality = DIFFERENTIAL
    field(3, 0, varint(Math.floor(Date.now() / 1000)))
  ]);
  feed = field(1, 2, header);

  await handler(req, res);
  assert.equal(res.statusCode, 502, 'a differential feed must not be mistaken for a full snapshot');
  assert.match(res.payload.error, /differential feeds are not supported/i);

  console.log('virtual-board-protobuf: all tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
