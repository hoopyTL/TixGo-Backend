const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const [scenario, eventId, token, configuredCount = "50"] = process.argv.slice(2);
const baseUrl = process.env.BASE_URL || "http://localhost:3000";

async function api(path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), { ...options, signal: AbortSignal.timeout(30000) });
  return { status: response.status, replayed: response.headers.get("Idempotent-Replayed"), body: await response.json() };
}

async function getEvent() {
  const result = await api("/events");
  assert.equal(result.status, 200);
  const event = result.body.find((entry) => entry.id === eventId);
  assert.ok(event, "Event does not exist");
  return event;
}

function book(key, requestedEventId = eventId) {
  return api("/bookings", { method: "POST", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": key,
  }, body: JSON.stringify({ eventId: requestedEventId }) });
}

async function testIdempotency(before) {
  const key = randomUUID();
  const first = await book(key);
  const replay = await book(key);
  const mismatch = await book(key, randomUUID());
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(replay.status, 200);
  assert.equal(replay.replayed, "true");
  assert.equal(replay.body.data.id, first.body.data.id);
  assert.equal(mismatch.status, 400);
  assert.equal((await getEvent()).remainTickets, before.remainTickets - 1);
  console.log("PASS: create=201, replay=200 (same booking ID), mismatch=400, exactly one ticket consumed.");
  console.log(`Booking ID: ${first.body.data.id}`);
}

async function testRace(before) {
  const count = Number(configuredCount);
  assert.ok(Number.isInteger(count) && count > 0 && count <= 200, "Request count must be an integer from 1 to 200");
  const results = await Promise.all(Array.from({ length: count }, () => book(randomUUID())));
  const created = results.filter((result) => result.status === 201);
  const soldOut = results.filter((result) => result.status === 409);
  console.log(`HTTP statuses: ${JSON.stringify(results.reduce((counts, result) => { counts[result.status] = (counts[result.status] || 0) + 1; return counts; }, {}))}`);
  assert.equal(created.length, Math.min(count, before.remainTickets));
  assert.equal(created.length + soldOut.length, count, "Unexpected errors: inspect API logs");
  assert.equal(new Set(created.map((result) => result.body.data.id)).size, created.length);
  const after = await getEvent();
  assert.equal(after.remainTickets, before.remainTickets - created.length);
  assert.ok(after.remainTickets >= 0);
  console.log(`PASS: ${created.length} bookings, ${soldOut.length} sold-out responses, ${after.remainTickets} tickets remaining.`);
}

async function main() {
  assert.match(eventId || "", /^[0-9a-f-]{36}$/i, "Provide an event UUID");
  assert.match(token || "", /^[^.]+\.[^.]+\.[^.]+$/, "Provide the access token returned by /auth/login");
  assert.ok(["idempotency", "race"].includes(scenario), "Unknown scenario");
  assert.equal((await api("/auth/me", { headers: { Authorization: `Bearer ${token}` } })).status, 200, "Access token is invalid or expired");
  const before = await getEvent();
  assert.ok(before.remainTickets > 0, "Use an event with remaining tickets");
  if (scenario === "idempotency") await testIdempotency(before);
  else await testRace(before);
}

main().catch((error) => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; });
