const assert = require("node:assert/strict");

function assertSuccess(response, statusCode, code, metaKeys) {
  assert.equal(response.status, statusCode, JSON.stringify(response.body));
  const body = response.body;
  assert.deepEqual(Object.keys(body).sort(),
    ["message", "code", "statusCode", "data", ...(metaKeys ? ["meta"] : [])].sort());
  assert.equal(body.statusCode, response.status);
  assert.equal(body.code, code);
  assert.equal(typeof body.message, "string");
  assert.ok(body.message.trim());
  assert.equal(typeof body.data, "object");
  assert.notEqual(body.data, null);
  if (metaKeys) assert.deepEqual(Object.keys(body.meta).sort(), [...metaKeys].sort());
}

function assertBookingReplay(created, replay) {
  assertSuccess(created, 201, "BOOKING_CONFIRMED");
  assertSuccess(replay, 200, "BOOKING_CONFIRMED");
  assert.equal(replay.headers["idempotent-replayed"], "true");
  assert.deepEqual(replay.body, { ...created.body, statusCode: 200 },
    "Replay preserves the original operation snapshot with the current HTTP status");
}

module.exports = { assertSuccess, assertBookingReplay };
