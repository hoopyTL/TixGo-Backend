const { assertBookingReplay } = require("./helpers/success-response");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const express = require("express");
const supertest = require("supertest");
const { createFixture, until, pause, stopChild, recordEvidence } = require("./helpers/reservation-fixture");

const execFileAsync = promisify(execFile);
let f;
let redis;

before(async function () {
  this.timeout(30000);
  f = await createFixture();
  const { createClient } = require("redis");
  redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: 1000 } });
  redis.on("error", () => {});
  await redis.connect();
});

after(async function () {
  this.timeout(15000);
  if (redis?.isOpen) await redis.quit();
  if (f) await f.close();
});

function authorized(request, actor = f.buyer) {
  return request.set("Authorization", `Bearer ${actor.token}`);
}

async function stored(id) {
  return (await f.pool.query("SELECT * FROM reservations WHERE id=$1", [id])).rows[0];
}

describe("PostgreSQL reservation lifecycle", () => {
  it("creates all seats and exposes only availability, never reservation owner data", async () => {
    const event = await f.event(3);
    const held = await f.held(event);
    const response = await f.request().get(`/events/${event.id}/seats`);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 3);
    const seat = response.body.data.find((row) => row.id === held.input.seatId);
    assert.equal(seat.status, "HELD");
    assert.equal(JSON.stringify(response.body).includes(f.buyer.id), false);
    assert.equal(JSON.stringify(response.body).includes(held.input.reservationId), false);
    assert.deepEqual(await f.invariant(event.id), { total: 3, remaining: 2, held: 1, booked: 0, distinct_seats: 0 });
  });

  it("retries a hold without extending expiry or decrementing stock again", async () => {
    const event = await f.event();
    const first = await f.held(event);
    const before = await stored(first.input.reservationId);
    const retry = await f.hold(event, f.buyer, first.input).response;
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(new Date(retry.body.data.expiresAt).getTime(), before.expires_at.getTime());
    assert.equal((await f.invariant(event.id)).remaining, 2);
  });

  it("validates identity, strict payload, ownership and seat/event membership", async () => {
    const event = await f.event();
    const otherEvent = await f.event();
    const first = await f.held(event);
    assert.equal((await f.hold(event, f.other, first.input).response).status, 404);
    assert.equal((await f.hold(event, f.buyer, { ...first.input, seatId: event.seats[1].id }).response).status, 400);
    assert.equal((await f.hold(otherEvent, f.buyer, { seatId: event.seats[0].id }).response).status, 404);
    assert.equal((await f.hold(event, f.buyer, { ttl: 900 }).response).status, 400);
    assert.equal((await f.request().post("/bookings/hold").send(first.input)).status, 401);
    assert.equal((await authorized(f.request().get(`/bookings/holds/${first.input.reservationId}`), f.other)).status, 404);
    assert.equal((await authorized(f.request().delete(`/bookings/holds/${first.input.reservationId}`), f.other)).status, 404);
    await f.invariant(event.id);
    await f.invariant(otherEvent.id);
  });

  it("allows exactly one of 100 independent hold IDs across two owners to claim one seat", async function () {
    this.timeout(30000);
    const event = await f.event(1);
    const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => f.hold(event, index % 2 ? f.buyer : f.other).response));
    assert.equal(responses.filter((response) => response.status === 201).length, 1);
    assert.equal(responses.filter((response) => response.status === 409).length, 99, JSON.stringify(responses.map((response) => response.status)));
    assert.deepEqual(await f.invariant(event.id), { total: 1, remaining: 0, held: 1, booked: 0, distinct_seats: 0 });
  });

  it("handles simultaneous reuse of a reservation UUID across events without losing stock", async () => {
    const one = await f.event(1);
    const two = await f.event(1);
    const reservationId = randomUUID();
    const responses = await Promise.all([f.hold(one, f.buyer, { reservationId }).response, f.hold(two, f.buyer, { reservationId }).response]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 400]);
    const states = await Promise.all([f.invariant(one.id), f.invariant(two.id)]);
    assert.equal(states.reduce((sum, state) => sum + state.held, 0), 1);
    assert.equal(states.reduce((sum, state) => sum + state.remaining, 0), 1);
  });

  it("releases once, rejects terminal ID reuse, and leaves a later hold unaffected", async () => {
    const event = await f.event(1);
    const first = await f.held(event);
    const endpoint = `/bookings/holds/${first.input.reservationId}`;
    const responses = await Promise.all(Array.from({ length: 8 }, () => authorized(f.request().delete(endpoint))));
    assert.ok(responses.every((response) => response.status === 204));
    assert.equal((await f.invariant(event.id)).remaining, 1);
    const terminalRetry = await f.hold(event, f.buyer, first.input).response;
    assert.equal(terminalRetry.status, 409);
    assert.equal(terminalRetry.body.code, "RESERVATION_RELEASED");
    const terminalConfirm = await f.confirm(first.input);
    assert.equal(terminalConfirm.status, 409);
    assert.equal(terminalConfirm.body.code, "RESERVATION_RELEASED");
    const next = await f.held(event, f.other);
    assert.equal((await authorized(f.request().delete(endpoint))).status, 204);
    assert.equal((await stored(next.input.reservationId)).status, "HELD");
    assert.equal((await f.invariant(event.id)).remaining, 0);
  });

  it("confirms without a second decrement and replays a committed result", async () => {
    const event = await f.event(5);
    const first = await f.held(event);
    const key = randomUUID();
    assert.equal((await f.invariant(event.id)).remaining, 4);
    const created = await f.confirm(first.input, key);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await f.invariant(event.id)).remaining, 4);
    const replay = await f.confirm(first.input, key);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers["idempotent-replayed"], "true");
    assertBookingReplay(created, replay);
    assert.equal((await f.invariant(event.id)).booked, 1);
    assert.equal((await f.confirm(first.input)).status, 409);
    assert.equal((await authorized(f.request().delete(`/bookings/holds/${first.input.reservationId}`))).status, 409);
  });

  it("creates one booking under concurrent same-key and different-key confirmation", async function () {
    this.timeout(30000);
    const event = await f.event(2);
    const first = await f.held(event);
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 100 }, () => f.confirm(first.input, key)));
    assert.equal(responses.filter((response) => response.status === 201).length, 1);
    assert.equal(responses.filter((response) => response.status === 200).length, 99);
    assert.equal(new Set(responses.map((response) => response.body.data.id)).size, 1);
    const second = await f.held(event, f.buyer, { seatId: event.seats[1].id });
    const contenders = await Promise.all(Array.from({ length: 8 }, () => f.confirm(second.input)));
    assert.equal(contenders.filter((response) => response.status === 201).length, 1);
    assert.equal(contenders.filter((response) => response.status === 409).length, 7);
    assert.equal((await f.invariant(event.id)).booked, 2);
  });

  it("isolates keys by user, rejects payload/operation reuse and requires a reservation for new purchases", async () => {
    const event = await f.event(2);
    const one = await f.held(event);
    const two = await f.held(event, f.other, { seatId: event.seats[1].id });
    const key = randomUUID();
    assert.equal((await f.confirm(one.input, key)).status, 201);
    assert.equal((await f.confirm(two.input, key, f.other)).status, 201);
    assert.equal((await f.confirm(two.input, key)).status, 400);
    assert.equal((await f.confirm({ eventId: event.id }, randomUUID())).status, 400);
    assert.equal((await f.confirm(one.input, "")).status, 400);
    assert.equal((await f.invariant(event.id)).booked, 2);
  });

  it("documents in-flight records and operation scoping without consuming inventory", async () => {
    const event = await f.event(1);
    const held = await f.held(event);
    const { generateRequestHash } = require("../dist/utils/hash");
    const key = randomUUID();
    const canonical = { operation: "booking.confirm.v2", ...held.input };
    const hash = generateRequestHash(f.buyer.id, canonical);
    await f.pool.query("INSERT INTO idempotency_keys(key,user_id,operation,request_hash,status,updated_at) VALUES($1,$2,'booking.confirm.v2',$3,'PROCESSING',NOW())", [key, f.buyer.id, hash]);
    const pending = await f.confirm(held.input, key);
    assert.equal(pending.status, 409);
    assert.equal(pending.body.code, "REQUEST_IN_PROGRESS");
    await f.pool.query("UPDATE idempotency_keys SET operation='booking.other.v1' WHERE key=$1 AND user_id=$2", [key, f.buyer.id]);
    assert.equal((await f.confirm(held.input, key)).status, 400);
    assert.equal((await f.invariant(event.id)).booked, 0);
  });

  it("retains aged keys rather than interpreting them as a new purchase", async () => {
    const event = await f.event(1);
    const held = await f.held(event);
    const key = randomUUID();
    const created = await f.confirm(held.input, key);
    await f.pool.query("UPDATE idempotency_keys SET created_at=NOW()-interval '1 year',updated_at=NOW()-interval '1 year' WHERE key=$1 AND user_id=$2", [key, f.buyer.id]);
    const replay = await f.confirm(held.input, key);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.id, created.body.data.id);
    assert.equal((await f.invariant(event.id)).booked, 1);
  });

  it("replays the exact legacy v1 snapshot after cutover and cancellation without reopening direct purchase", async () => {
    const event = await f.event(1);
    const held = await f.held(event);
    const created = await f.confirm(held.input);
    const booking = created.body.data;
    const legacy = { id: booking.id, userId: booking.userId, eventId: booking.eventId, status: booking.status, createdAt: booking.createdAt };
    const { generateRequestHash } = require("../dist/utils/hash");
    const key = randomUUID();
    await f.pool.query("INSERT INTO idempotency_keys(key,user_id,request_hash,status,response_status,response_body,updated_at) VALUES($1,$2,$3,'COMPLETED',201,$4,NOW())", [key, f.buyer.id, generateRequestHash(f.buyer.id, { eventId: event.id }), JSON.stringify(legacy)]);
    const replay = await f.confirm({ eventId: event.id }, key);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers["idempotent-replayed"], "true");
    assert.deepEqual(replay.body.data, legacy);
    assert.equal((await f.confirm(held.input, key)).status, 400);
    assert.equal((await authorized(f.request().post(`/bookings/${booking.id}/cancel`)).send({})).status, 200);
    assert.deepEqual((await f.confirm({ eventId: event.id }, key)).body.data, legacy);
    assert.equal((await f.confirm({ eventId: event.id })).status, 400);
    assert.equal((await f.invariant(event.id)).remaining, 1);
  });

  it("cancels once, permits a new owner to buy the seat and preserves creation replay", async () => {
    const event = await f.event(1);
    const first = await f.held(event);
    const key = randomUUID();
    const created = await f.confirm(first.input, key);
    const id = created.body.data.id;
    const responses = await Promise.all(Array.from({ length: 8 }, () => authorized(f.request().post(`/bookings/${id}/cancel`)).send({})));
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal((await f.invariant(event.id)).remaining, 1);
    assert.equal((await stored(first.input.reservationId)).status, "CONFIRMED");
    const next = await f.held(event, f.other);
    assert.equal((await f.confirm(next.input, randomUUID(), f.other)).status, 201);
    assertBookingReplay(created, await f.confirm(first.input, key));
    assert.equal((await authorized(f.request().get(`/bookings/${id}`))).body.data.status, "CANCELLED");
    await f.service.expireBatch(100);
    assert.equal((await f.invariant(event.id)).booked, 1);
  });

  it("normalizes expiry without a running worker and commits restoration despite HTTP conflict", async () => {
    const event = await f.event(1);
    const first = await f.held(event);
    await f.expire(first.input.reservationId);
    const confirmed = await f.confirm(first.input);
    assert.equal(confirmed.status, 409);
    assert.equal(confirmed.body.code, "RESERVATION_EXPIRED");
    assert.equal((await stored(first.input.reservationId)).status, "EXPIRED");
    assert.equal((await f.invariant(event.id)).remaining, 1);
    assert.equal((await f.hold(event, f.buyer, first.input).response).status, 409);
    const second = await f.held(event);
    await f.expire(second.input.reservationId);
    const status = await authorized(f.request().get(`/bookings/holds/${second.input.reservationId}`));
    assert.equal(status.status, 200);
    assert.equal(status.body.data.status, "EXPIRED");
    assert.equal((await f.invariant(event.id)).remaining, 1);
  });

  it("reclaims an expired hold in place before allowing another owner to hold", async () => {
    const event = await f.event(1);
    const old = await f.held(event);
    await f.expire(old.input.reservationId);
    const next = await f.held(event, f.other);
    assert.equal((await stored(old.input.reservationId)).status, "EXPIRED");
    assert.equal((await stored(next.input.reservationId)).status, "HELD");
    await authorized(f.request().delete(`/bookings/holds/${old.input.reservationId}`));
    assert.equal((await f.invariant(event.id)).remaining, 0);
  });

  it("checks real database time after waiting for the Event lock", async () => {
    const event = await f.event(1);
    const held = await f.held(event);
    const blocker = await f.pool.connect();
    try {
      await f.pool.query("UPDATE reservations SET expires_at=clock_timestamp()+interval '350 milliseconds' WHERE id=$1", [held.input.reservationId]);
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [event.id]);
      const { rows: [{ pid }] } = await blocker.query("SELECT pg_backend_pid() AS pid");
      const pending = f.confirm(held.input).then((response) => response);
      await until(async () => (await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))", [pid])).rowCount > 0, "Confirm waits for Event lock");
      await pause(500);
      await blocker.query("COMMIT");
      const response = await pending;
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal((await stored(held.input.reservationId)).status, "EXPIRED");
      assert.equal((await f.invariant(event.id)).remaining, 1);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });

  it("keeps confirmation accepted before expiry even when commit occurs after expiry", async () => {
    const event = await f.event(1);
    const held = await f.held(event);
    await f.pool.query("UPDATE reservations SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [held.input.reservationId]);
    const gate = await f.gate("bookings", event.id);
    try {
      const pending = f.confirm(held.input).then((response) => response);
      await gate.wait();
      await until(async () => (await f.pool.query("SELECT expires_at <= clock_timestamp() AS expired FROM reservations WHERE id=$1", [held.input.reservationId])).rows[0].expired, "Wall time passes expiry");
      const worker = f.service.expireBatch(100);
      await gate.open();
      assert.equal((await pending).status, 201);
      await worker;
      assert.equal((await stored(held.input.reservationId)).status, "CONFIRMED");
      assert.equal((await f.invariant(event.id)).remaining, 0);
    } finally { await gate.close(); }
  });

  it("arbitrates expiry, release and confirmation with one terminal transition", async () => {
    const event = await f.event(1);
    const held = await f.held(event);
    await f.expire(held.input.reservationId);
    const [confirmation, release] = await Promise.all([
      f.confirm(held.input),
      authorized(f.request().delete(`/bookings/holds/${held.input.reservationId}`)),
      f.service.expireBatch(100), f.service.expireBatch(100),
    ]);
    assert.equal(confirmation.status, 409);
    assert.equal(release.status, 204);
    assert.ok(["EXPIRED", "RELEASED"].includes((await stored(held.input.reservationId)).status));
    assert.deepEqual(await f.invariant(event.id), { total: 1, remaining: 1, held: 0, booked: 0, distinct_seats: 0 });
  });
});

describe("Reservation rollback, cache and process recovery", () => {
  it("retries a timed-out pool acquisition after existing transactions finish", async function () {
    this.timeout(15000);
    const event = await f.event(1);
    const held = await f.held(event);
    const blockers = Array.from({ length: 10 }, () => f.db.$queryRawUnsafe("SELECT pg_sleep(2.8)::text"));
    const running = Promise.all(blockers);
    await until(async () => {
      const result = await f.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND query=$1 AND state='active'", ["SELECT pg_sleep(2.8)::text"]);
      return result.rows[0].n === 10;
    }, "All API pool connections are held by existing queries");
    try {
      const start = Date.now();
      const response = await f.confirm(held.input);
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.ok(Date.now() - start >= 2000, "The first 2s pool acquisition budget was exhausted");
      assert.equal((await f.invariant(event.id)).booked, 1);
    } finally { await running; }
  });

  it("bounds lock waits, returns retryable busy and preserves the pending hold", async () => {
    const event = await f.event(1);
    const held = await f.held(event);
    const key = randomUUID();
    const previous = Object.fromEntries(["BOOKING_LOCK_TIMEOUT_MS", "BOOKING_RETRY_ATTEMPTS", "BOOKING_RETRY_DEADLINE_MS"].map((name) => [name, process.env[name]]));
    const blocker = await f.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [event.id]);
      process.env.BOOKING_LOCK_TIMEOUT_MS = "100";
      process.env.BOOKING_RETRY_ATTEMPTS = "2";
      process.env.BOOKING_RETRY_DEADLINE_MS = "1000";
      const start = Date.now();
      const response = await f.confirm(held.input, key);
      assert.equal(response.status, 503, JSON.stringify(response.body));
      assert.equal(response.body.code, "BOOKING_BUSY");
      assert.ok(response.headers["retry-after"]);
      assert.ok(Date.now() - start < 1500, "Busy response obeys a finite retry budget");
      assert.equal((await stored(held.input.reservationId)).status, "HELD");
      assert.equal((await f.invariant(event.id)).booked, 0);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    assert.equal((await f.confirm(held.input, key)).status, 201);
  });

  it("recovers from an actual PostgreSQL deadlock by retrying the whole transaction", async function () {
    this.timeout(10000);
    const one = await f.event(1);
    const two = await f.event(1);
    const { withBookingTransaction } = require("../dist/services/booking-transaction");
    const calls = [0, 0];
    let ready = 0;
    let release;
    const bothLocked = new Promise((resolve) => { release = resolve; });
    async function compete(index, first, second) {
      return withBookingTransaction(async (tx) => {
        calls[index]++;
        await tx.$queryRawUnsafe("SELECT id FROM events WHERE id=$1 FOR UPDATE", first);
        if (calls[index] === 1 && ++ready === 2) release();
        await bothLocked;
        await tx.$queryRawUnsafe("SELECT id FROM events WHERE id=$1 FOR UPDATE", second);
        return "committed";
      });
    }
    const result = await Promise.all([compete(0, one.id, two.id), compete(1, two.id, one.id)]);
    assert.deepEqual(result, ["committed", "committed"]);
    assert.equal(calls[0] + calls[1], 3, `One transaction should be retried after SQLSTATE 40P01: ${calls}`);
    await f.invariant(one.id);
    await f.invariant(two.id);
  });

  it("does not retry permanent business errors", async () => {
    const { withBookingTransaction } = require("../dist/services/booking-transaction");
    const { AppError } = require("../dist/errors/AppError");
    let attempts = 0;
    await assert.rejects(() => withBookingTransaction(async () => {
      attempts++;
      throw new AppError(409, "Permanent test conflict", "TEST_CONFLICT");
    }), (error) => error.statusCode === 409 && error.code === "TEST_CONFLICT");
    assert.equal(attempts, 1);
  });

  it("rolls back hold state if inventory persistence fails", async () => {
    const event = await f.event(1);
    const remove = await f.trigger("events", event.id, "RAISE EXCEPTION 'Injected inventory failure'");
    const attempt = f.hold(event);
    try { assert.equal((await attempt.response).status, 500); } finally { await remove(); }
    assert.equal(await stored(attempt.input.reservationId), undefined);
    assert.equal((await f.invariant(event.id)).remaining, 1);
    assert.equal((await f.hold(event, f.buyer, attempt.input).response).status, 201);
  });

  for (const table of ["bookings", "idempotency_keys"]) {
    it(`rolls back confirmation when ${table} persistence fails, then permits retry`, async () => {
      const event = await f.event(1);
      const held = await f.held(event);
      const key = randomUUID();
      const remove = await f.trigger(table, event.id, "RAISE EXCEPTION 'Injected confirmation failure'");
      try { assert.equal((await f.confirm(held.input, key)).status, 500); } finally { await remove(); }
      assert.equal((await stored(held.input.reservationId)).status, "HELD");
      assert.equal((await f.invariant(event.id)).booked, 0);
      assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM idempotency_keys WHERE user_id=$1 AND key=$2", [f.buyer.id, key])).rows[0].n, 0);
      assert.equal((await f.confirm(held.input, key)).status, 201);
      await f.invariant(event.id);
    });
  }

  it("rolls back expiry status and restoration together when the stock write fails", async () => {
    const event = await f.event(1);
    const held = await f.held(event);
    await f.expire(held.input.reservationId);
    const remove = await f.trigger("events", event.id, "RAISE EXCEPTION 'Injected expiry failure'");
    try { await assert.rejects(() => f.service.expireBatch(100)); } finally { await remove(); }
    assert.equal((await stored(held.input.reservationId)).status, "HELD");
    assert.equal((await f.invariant(event.id)).remaining, 0);
    await f.service.expireBatch(100);
    await f.service.expireBatch(100);
    assert.equal((await f.invariant(event.id)).remaining, 1);
  });

  it("continues to use PostgreSQL after Redis key loss or stale cache data", async () => {
    const event = await f.event(1);
    const held = await f.held(event);
    const key = `reservation:${held.input.reservationId}`;
    await redis.del(key);
    assert.equal((await f.hold(event, f.other).response).status, 409);
    await redis.set(key, JSON.stringify({ status: "RELEASED", expiresAt: "2099-01-01T00:00:00.000Z" }));
    const status = await authorized(f.request().get(`/bookings/holds/${held.input.reservationId}`));
    assert.equal(status.body.data.status, "HELD");
    assert.equal((await f.confirm(held.input)).status, 201);
    await redis.set(key, JSON.stringify({ status: "HELD", expiresAt: "2099-01-01T00:00:00.000Z" }));
    assert.equal((await f.hold(event, f.other).response).status, 409);
    await f.invariant(event.id);
  });

  it("uses absolute cache expiry and does not extend the cache on hold retry", async () => {
    const event = await f.event(1);
    const held = await f.held(event);
    const key = `reservation:${held.input.reservationId}`;
    await until(async () => (await redis.pTTL(key)) > 0, "Hold cache is written");
    const first = await redis.pTTL(key);
    await pause(50);
    assert.equal((await f.hold(event, f.buyer, held.input).response).status, 200);
    const second = await redis.pTTL(key);
    assert.ok(second <= first, `Retry extended cache TTL: ${first} -> ${second}`);
    const dbExpiry = (await stored(held.input.reservationId)).expires_at.getTime();
    assert.ok(Math.abs((Date.now() + second) - dbExpiry) < 1000);
  });

  it("bounds Redis command timeout after PostgreSQL commit and tolerates a delayed stale write", async function () {
    this.timeout(10000);
    const event = await f.event(1);
    const held = await f.held(event);
    const snapshot = await stored(held.input.reservationId);
    await redis.sendCommand(["CLIENT", "PAUSE", "1200", "ALL"]);
    const start = Date.now();
    const response = await f.confirm(held.input);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const elapsedMs = Date.now() - start;
    assert.ok(elapsedMs < 1000, "Redis command timeout must not wait for the whole pause");
    assert.equal((await f.invariant(event.id)).booked, 1);
    await redis.ping();
    const { updateReservationCache } = require("../dist/configs/redis");
    const cacheKey = `reservation:${snapshot.id}`;
    await redis.del(cacheKey);
    await until(async () => {
      await updateReservationCache({ id: snapshot.id, status: "HELD", expiresAt: snapshot.expires_at });
      const value = await redis.get(cacheKey);
      return value && JSON.parse(value).status === "HELD";
    }, "A delayed stale HELD cache write actually occurs");
    assert.equal((await f.hold(event, f.other).response).status, 409);
    assert.equal((await authorized(f.request().get(`/bookings/holds/${snapshot.id}`))).body.data.status, "CONFIRMED");
    recordEvidence("redis-deadline", { pauseMs: 1200, responseStatus: response.status, elapsedMs, snapshot: await f.invariant(event.id), delayedStaleWriteObserved: true });
  });

  it("runs two worker processes, then restarts a worker without restoring twice", async function () {
    this.timeout(20000);
    const event = await f.event(3);
    for (const seat of event.seats) {
      const held = await f.held(event, f.buyer, { seatId: seat.id });
      await f.expire(held.input.reservationId);
    }
    const workers = await Promise.all([f.child("dist/workers/reservation-expiry.worker.js", { RESERVATION_POLL_MS: "50" }), f.child("dist/workers/reservation-expiry.worker.js", { RESERVATION_POLL_MS: "50" })]);
    try {
      await until(async () => (await f.invariant(event.id)).held === 0, "Two expiry workers drain expired rows");
      await until(async () => workers.some((worker) => worker.output().includes('"oldestLagMs":')), "Worker reports expiry backlog lag");
    } finally { for (const worker of workers) await stopChild(worker); }
    const restarted = await f.child("dist/workers/reservation-expiry.worker.js", { RESERVATION_POLL_MS: "50" });
    try { await pause(200); assert.equal((await f.invariant(event.id)).remaining, 3); } finally { await stopChild(restarted); }
  });

  it("recovers an expiry worker killed between the state update and inventory restoration", async function () {
    this.timeout(20000);
    const event = await f.event(1);
    const held = await f.held(event);
    await f.expire(held.input.reservationId);
    const gate = await f.gate("events", event.id);
    const worker = await f.child("dist/workers/reservation-expiry.worker.js", { RESERVATION_POLL_MS: "50" });
    const timeline = [];
    try {
      await gate.wait();
      timeline.push({ at: new Date().toISOString(), event: "worker_reached_gate_between_state_and_stock", pid: worker.pid });
      const closed = new Promise((resolve) => worker.once("close", resolve));
      worker.kill("SIGKILL");
      await closed;
      timeline.push({ at: new Date().toISOString(), event: "worker_killed_before_commit" });
      await gate.open();
      assert.equal((await stored(held.input.reservationId)).status, "HELD");
      assert.equal((await f.invariant(event.id)).remaining, 0);
      timeline.push({ at: new Date().toISOString(), event: "rollback_verified", snapshot: await f.invariant(event.id) });
    } finally { await gate.close(); await stopChild(worker); }
    const restarted = await f.child("dist/workers/reservation-expiry.worker.js", { RESERVATION_POLL_MS: "50" });
    try {
      await until(async () => (await stored(held.input.reservationId)).status === "EXPIRED", "Restarted worker completes expiry");
      timeline.push({ at: new Date().toISOString(), event: "worker_restart_committed_expiry", pid: restarted.pid, snapshot: await f.invariant(event.id) });
      const closed = new Promise((resolve) => restarted.once("close", resolve));
      restarted.kill("SIGKILL");
      await closed;
      timeline.push({ at: new Date().toISOString(), event: "worker_killed_after_commit" });
      assert.equal((await f.invariant(event.id)).remaining, 1);
    } finally { await stopChild(restarted); }
    const afterCommit = await f.child("dist/workers/reservation-expiry.worker.js", { RESERVATION_POLL_MS: "50" });
    try {
      await pause(200);
      assert.equal((await f.invariant(event.id)).remaining, 1);
      timeline.push({ at: new Date().toISOString(), event: "second_restart_did_not_restore_twice", snapshot: await f.invariant(event.id) });
      recordEvidence("worker-crash-timeline", { timeline });
    } finally { await stopChild(afterCommit); }
  });

  it("rolls back an API process killed after a database write but before commit", async function () {
    this.timeout(20000);
    const event = await f.event(1);
    const held = await f.held(event);
    const key = randomUUID();
    const api = await f.api();
    const gate = await f.gate("bookings", event.id, "AFTER");
    const timeline = [];
    try {
      const pending = f.confirm(held.input, key, f.buyer, api.address).then((response) => ({ response }), (error) => ({ error }));
      await gate.wait();
      timeline.push({ at: new Date().toISOString(), event: "booking_written_before_commit", pid: api.child.pid });
      const closed = new Promise((resolve) => api.child.once("close", resolve));
      api.child.kill("SIGKILL");
      await closed;
      timeline.push({ at: new Date().toISOString(), event: "api_killed_before_commit" });
      assert.ok((await pending).error, "The killed connection cannot return a success");
      await gate.open();
      assert.equal((await stored(held.input.reservationId)).status, "HELD");
      assert.equal((await f.invariant(event.id)).booked, 0);
      timeline.push({ at: new Date().toISOString(), event: "rollback_verified", snapshot: await f.invariant(event.id) });
      assert.equal((await f.confirm(held.input, key)).status, 201);
      assert.equal((await f.invariant(event.id)).booked, 1);
      timeline.push({ at: new Date().toISOString(), event: "same_key_retry_committed_once", snapshot: await f.invariant(event.id) });
      recordEvidence("api-before-commit-timeline", { timeline });
    } finally { await gate.close(); await stopChild(api.child); }
  });

  it("replays after commit when a proxy loses the response and the API process is killed", async function () {
    this.timeout(20000);
    const event = await f.event(1);
    const held = await f.held(event);
    const key = randomUUID();
    const api = await f.api();
    const timeline = [];
    const proxy = express();
    proxy.use(express.json());
    proxy.post("/bookings", async (req, res) => {
      const response = await fetch(`${api.address}/bookings`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.buyer.token}`, "Idempotency-Key": key }, body: JSON.stringify(req.body) });
      await response.json();
      timeline.push({ at: new Date().toISOString(), event: "upstream_committed_response_buffered_by_proxy", pid: api.child.pid });
      api.child.kill("SIGKILL");
      res.destroy();
      timeline.push({ at: new Date().toISOString(), event: "api_killed_client_response_lost" });
    });
    const server = proxy.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      await assert.rejects(() => supertest(server).post("/bookings").send(held.input).then((response) => response), { code: "ECONNRESET" });
      const restarted = await f.api();
      try {
        const replay = await f.confirm(held.input, key, f.buyer, restarted.address);
        assert.equal(replay.status, 200);
        assert.equal(replay.headers["idempotent-replayed"], "true");
        assert.equal((await f.invariant(event.id)).booked, 1);
        timeline.push({ at: new Date().toISOString(), event: "restarted_api_replayed_same_booking", pid: restarted.child.pid, bookingId: replay.body.data.id, snapshot: await f.invariant(event.id) });
        recordEvidence("api-after-commit-timeline", { timeline });
      } finally { await stopChild(restarted.child); }
    } finally { await new Promise((resolve) => server.close(resolve)); await stopChild(api.child); }
  });

  it("serializes duplicate and conflicting-payload confirmations across two API processes", async function () {
    this.timeout(20000);
    const event = await f.event(2);
    const held = await f.held(event);
    const second = await f.held(event, f.buyer, { seatId: event.seats[1].id });
    const apis = await Promise.all([f.api(), f.api()]);
    try {
      const key = randomUUID();
      const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => f.confirm(held.input, key, f.buyer, apis[index % 2].address)));
      assert.equal(responses.filter((response) => response.status === 201).length, 1);
      assert.equal(responses.filter((response) => response.status === 200).length, 99);
      assert.equal(new Set(responses.map((response) => response.body.data.id)).size, 1);
      const payloadConflict = await f.confirm(second.input, key, f.buyer, apis[1].address);
      assert.equal(payloadConflict.status, 400);
      const raceKey = randomUUID();
      const race = await Promise.all([f.confirm(second.input, raceKey, f.buyer, apis[0].address), f.confirm(held.input, raceKey, f.buyer, apis[1].address)]);
      assert.ok(race.some((response) => response.status === 201));
      assert.ok(race.some((response) => [400, 409].includes(response.status)));
      assert.equal((await f.invariant(event.id)).booked, 2);
    } finally { for (const api of apis) await stopChild(api.child); }
  });

  it("survives Redis restart while a hold exists and can confirm during Redis outage", async function () {
    this.timeout(30000);
    const event = await f.event(1);
    const held = await f.held(event);
    await redis.quit();
    await execFileAsync("docker", ["compose", "--profile", "test", "stop", "test-redis"], { timeout: 15000 });
    try {
      assert.equal((await f.hold(event, f.other).response).status, 409);
      assert.equal((await f.confirm(held.input)).status, 201);
      await f.invariant(event.id);
    } finally {
      await execFileAsync("docker", ["compose", "--profile", "test", "up", "-d", "test-redis"], { timeout: 15000 });
      const { createClient } = require("redis");
      redis = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 1000, reconnectStrategy: false } });
      redis.on("error", () => {});
      await until(async () => { if (!redis.isOpen) await redis.connect(); return (await redis.ping()) === "PONG"; }, "Redis restarts");
    }
    assert.equal((await f.hold(event, f.other).response).status, 409);
    await f.invariant(event.id);
  });
});
