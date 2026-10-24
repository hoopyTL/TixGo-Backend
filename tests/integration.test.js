const supertest = require("supertest");
let apiServer;
function request(target) {
  return supertest(target === app ? apiServer : target);
}
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { spawnSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const { Pool } = require("pg");
const express = require("express");
const { readFileSync, readdirSync } = require("node:fs");

let app;
let db;
let admin;
let token;
let userId;
let organizer;
let administrator;
let schemaCreated = false;
const schema = `Test_${randomUUID().replaceAll("-", "")}`;
const password = "Integration-test-password";
const keyScopeMigration = "20261003090000_scope_idempotency_keys_to_user";
const eventFoundationMigration = "20261025090000_event_ownership_inventory";
const execFileAsync = promisify(execFile);

async function runApiScript(script, eventId, { baseUrl, count = 50 }) {
  try {
    const { stdout } = await execFileAsync("bash", [path.join(__dirname, script), eventId, token, String(count)], {
      env: { ...process.env, BASE_URL: baseUrl }, timeout: 20000,
    });
    return stdout;
  } catch (error) {
    throw new Error(`${script} failed: ${error.stdout || error.stderr || error.code}`);
  }
}

function dropBookingResponse() {
  const proxy = express();
  proxy.use((req, res, next) => {
    if (req.method === "POST" && req.path === "/bookings") {
      res.json = () => { res.destroy(); return res; };
    }
    next();
  });
  proxy.use(app);
  return proxy;
}

async function createLegacySchema(client, fixtureSchema, beforeMigration = keyScopeMigration) {
  await client.query(`CREATE SCHEMA "${fixtureSchema}"`);
  await client.query("SELECT set_config('search_path', $1, false)", [`"${fixtureSchema}"`]);
  const migrationsDir = path.join(__dirname, "../prisma/migrations");
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < beforeMigration)
    .map((entry) => entry.name).sort();
  for (const migration of migrations) {
    await client.query(readFileSync(path.join(migrationsDir, migration, "migration.sql"), "utf8"));
  }
}

async function seedLegacyKey(client) {
  const ids = { user: randomUUID(), otherUser: randomUUID(), event: randomUUID(), booking: randomUUID(), key: randomUUID() };
  await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'fixture'), ($3, $4, 'fixture')",
    [ids.user, `${ids.user}@example.com`, ids.otherUser, `${ids.otherUser}@example.com`]);
  await client.query("INSERT INTO events (id, title, total_tickets, remain_tickets, price) VALUES ($1, 'Legacy event', 3, 2, 100000)", [ids.event]);
  const { rows: [booking] } = await client.query("INSERT INTO bookings (id, user_id, event_id) VALUES ($1, $2, $3) RETURNING *", [ids.booking, ids.user, ids.event]);
  const cachedBooking = { id: booking.id, userId: booking.user_id, eventId: booking.event_id, status: booking.status, createdAt: booking.created_at.toISOString() };
  const hash = createHash("sha256").update(JSON.stringify({ userId: ids.user, body: { eventId: ids.event } })).digest("hex");
  await client.query("INSERT INTO idempotency_keys (key, user_id, request_hash, status, response_status, response_body, updated_at) VALUES ($1, $2, $3, 'COMPLETED', 201, $4, NOW())",
    [ids.key, ids.user, hash, JSON.stringify(cachedBooking)]);
  return ids;
}

async function assertMigratedKey(client, ids, snapshot) {
  assert.deepEqual((await client.query("SELECT * FROM idempotency_keys ORDER BY key")).rows, snapshot);
  assert.equal((await client.query("SELECT remain_tickets FROM events WHERE id = $1", [ids.event])).rows[0].remain_tickets, 2);
  assert.equal((await client.query("SELECT count(*)::int AS count FROM bookings WHERE id = $1", [ids.booking])).rows[0].count, 1);
  await client.query("INSERT INTO idempotency_keys (key, user_id, request_hash, updated_at) VALUES ($1, $2, 'new-hash', NOW())", [ids.key, ids.otherUser]);
  await assert.rejects(() => client.query("INSERT INTO idempotency_keys (key, user_id, request_hash, updated_at) VALUES ($1, $2, 'duplicate', NOW())", [ids.key, ids.user]), { code: "23505" });
}

async function checkLegacyMigration() {
  const client = await admin.connect();
  const fixtureSchema = `Migration_${randomUUID().replaceAll("-", "")}`;
  try {
    await createLegacySchema(client, fixtureSchema);
    const ids = await seedLegacyKey(client);
    const snapshot = (await client.query("SELECT * FROM idempotency_keys ORDER BY key")).rows;
    await client.query(readFileSync(path.join(__dirname, "../prisma/migrations", keyScopeMigration, "migration.sql"), "utf8"));
    await assertMigratedKey(client, ids, snapshot);
  } finally {
    try { await client.query(`DROP SCHEMA IF EXISTS "${fixtureSchema}" CASCADE`); }
    finally { client.release(true); }
  }
}

async function installInventoryFailure(eventId) {
  await admin.query(`CREATE FUNCTION "${schema}".reject_inventory_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.id = '${eventId}' THEN RAISE EXCEPTION 'Injected inventory update failure'; END IF;
      RETURN NEW;
    END $$`);
  await admin.query(`CREATE TRIGGER reject_inventory_update BEFORE UPDATE ON "${schema}".events
    FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_inventory_update()`);
}

async function removeInventoryFailure() {
  await admin.query(`DROP TRIGGER IF EXISTS reject_inventory_update ON "${schema}".events`);
  await admin.query(`DROP FUNCTION IF EXISTS "${schema}".reject_inventory_update()`);
}

async function registerUser() {
  const email = `test-${randomUUID()}@example.com`;
  const registered = await request(app).post("/auth/register").send({ email, password });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  assert.equal(registered.body.data.passwordHash, undefined);
  const loggedIn = await request(app).post("/auth/login").send({ email, password });
  assert.equal(loggedIn.status, 200);
  return { email, token: loggedIn.body.data.accessToken, userId: registered.body.data.id };
}

async function provisionUser(role) {
  const user = await registerUser();
  await db.user.update({ where: { id: user.userId }, data: { role } });
  const loggedIn = await request(app).post("/auth/login").send({ email: user.email, password });
  assert.equal(loggedIn.status, 200);
  return { ...user, token: loggedIn.body.data.accessToken };
}

function eventPayload(overrides = {}) {
  return { title: `Integration ${randomUUID()}`, totalTickets: 3, price: 100000, ...overrides };
}

function postEvent(payload = eventPayload(), accessToken = organizer.token) {
  const req = request(app).post("/events").send(payload);
  return accessToken ? req.set("Authorization", `Bearer ${accessToken}`) : req;
}

async function createEvent(tickets = 3) {
  const res = await postEvent(eventPayload({ totalTickets: tickets }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.remainTickets, tickets);
  return res.body.data;
}

function book(eventId, key = randomUUID(), accessToken = token) {
  const req = request(app).post("/bookings").set("Authorization", `Bearer ${accessToken}`).send({ eventId });
  return key === null ? req : req.set("Idempotency-Key", key);
}

before(async function () {
  const configured = process.env.TEST_DATABASE_URL;
  assert.ok(configured, "Set TEST_DATABASE_URL to a PostgreSQL database ending in _test. No development database will be used.");
  const url = new URL(configured);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.match(decodeURIComponent(url.pathname), /_test$/, "Test database name must end in _test.");
  admin = new Pool({ connectionString: url.toString() });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = "integration-test-secret-only";
  process.env.NODE_ENV = "test";
  const migrated = spawnSync(process.execPath, [path.join(__dirname, "../node_modules/prisma/build/index.js"), "migrate", "deploy"], {
    cwd: path.join(__dirname, ".."), env: process.env, encoding: "utf8", timeout: 20000,
  });
  assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
  url.searchParams.set("options", "-c statement_timeout=15000 -c search_path=public");
  process.env.DATABASE_URL = url.toString();
  ({ app } = require("../dist/app"));
  ({ db } = require("../dist/configs/db"));
  apiServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => apiServer.once("listening", resolve));
  assert.equal(apiServer.address().address, "127.0.0.1");
  ({ token, userId } = await registerUser());
  organizer = await provisionUser("organizer");
  administrator = await provisionUser("admin");
});

after(async () => {
  try {
    if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
    if (db) await db.$disconnect();
  }
  finally {
    if (admin) {
      try { if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  }
});

describe("Authentication with PostgreSQL", () => {
  it("registers and logs in a user without leaking password hashes", async () => {
    const user = await registerUser();
    assert.ok(user.token);
    const stored = await db.user.findUnique({ where: { id: user.userId } });
    assert.notEqual(stored.passwordHash, password);
    assert.equal(stored.email, user.email);
  });
  it("rejects duplicate registration", async () => {
    const user = await db.user.findUnique({ where: { id: userId } });
    const res = await request(app).post("/auth/register").send({ email: user.email, password });
    assert.equal(res.status, 409);
  });
  it("rejects wrong passwords", async () => {
    const user = await db.user.findUnique({ where: { id: userId } });
    const res = await request(app).post("/auth/login").send({ email: user.email, password: "wrong-password" });
    assert.equal(res.status, 401);
  });
  it("returns the authenticated user's identity", async () => {
    const res = await request(app).get("/auth/me").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.userId, userId);
  });
  it("rejects unsupported stored roles instead of signing a token", async () => {
    const user = await registerUser();
    await db.user.update({ where: { id: user.userId }, data: { role: "unsupported" } });
    const res = await request(app).post("/auth/login").send({ email: user.email, password });
    assert.equal(res.status, 403);
    assert.equal(res.body.data?.accessToken, undefined);
  });
});

describe("Events and booking with PostgreSQL", () => {
  it("uses the same mixed-case schema for ORM and raw SQL", async () => {
    const [current] = await db.$queryRaw`SELECT current_schema() AS name`;
    assert.equal(current.name, schema);
    const [timeout] = await db.$queryRaw`SHOW statement_timeout`;
    assert.equal(timeout.statement_timeout, "15s");
    const event = await createEvent();
    assert.equal((await book(event.id)).status, 201);
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 2);
  });
  it("creates and lists events", async () => {
    const event = await createEvent();
    const res = await request(app).get("/events");
    assert.equal(res.status, 200);
    assert.ok(res.body.some((entry) => entry.id === event.id));
  });
  it("creates one booking and decrements one ticket", async () => {
    const event = await createEvent();
    const res = await book(event.id);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.userId, userId);
    assert.equal(res.body.data.status, "CONFIRMED");
    assert.equal(await db.booking.count({ where: { eventId: event.id } }), 1);
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 2);
  });
  it("rolls back a booking and its key when inventory update fails, then permits retry", async () => {
    const event = await createEvent();
    const key = randomUUID();
    await installInventoryFailure(event.id);
    try {
      assert.equal((await book(event.id, key)).status, 500);
      assert.equal(await db.booking.count({ where: { eventId: event.id } }), 0);
      assert.equal(await db.idempotency.count({ where: { userId, key } }), 0);
      assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 3);
    } finally { await removeInventoryFailure(); }
    assert.equal((await book(event.id, key)).status, 201);
    assert.equal(await db.booking.count({ where: { eventId: event.id } }), 1);
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 2);
  });
  it("requires an idempotency key without changing inventory", async () => {
    const event = await createEvent();
    assert.equal((await book(event.id, null)).status, 400);
    assert.equal(await db.booking.count({ where: { eventId: event.id } }), 0);
  });
  it("rejects malformed event IDs", async () => {
    assert.equal((await book("invalid")).status, 400);
  });
  it("returns 404 for missing events and rolls back the key", async () => {
    const key = randomUUID();
    assert.equal((await book(randomUUID(), key)).status, 404);
    assert.equal(await db.idempotency.count({ where: { userId, key } }), 0);
  });
  it("replays a booking with HTTP 200 and identical ID even after selling out", async () => {
    const event = await createEvent(1);
    const key = randomUUID();
    const first = await book(event.id, key);
    const second = await book(event.id, key);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.headers["idempotent-replayed"], "true");
    assert.deepEqual(second.body, first.body);
    assert.equal(await db.booking.count({ where: { eventId: event.id } }), 1);
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 0);
  });
  it("replays the committed result after the original response connection is lost", async () => {
    const event = await createEvent();
    const key = randomUUID();
    const proxy = dropBookingResponse().listen(0, "127.0.0.1");
    await new Promise((resolve) => proxy.once("listening", resolve));
    try {
      await assert.rejects(async () => request(proxy).post("/bookings")
        .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key)
        .send({ eventId: event.id }), { code: "ECONNRESET" });
    } finally { await new Promise((resolve) => proxy.close(resolve)); }
    const saved = await db.idempotency.findUnique({ where: { userId_key: { userId, key } } });
    assert.equal(saved.status, "COMPLETED");
    const replay = await book(event.id, key);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers["idempotent-replayed"], "true");
    assert.equal(replay.body.data.id, JSON.parse(saved.responseBody).id);
    assert.equal(await db.booking.count({ where: { eventId: event.id } }), 1);
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 2);
  });
  it("rejects the same key with a different payload", async () => {
    const firstEvent = await createEvent();
    const otherEvent = await createEvent();
    const key = randomUUID();
    assert.equal((await book(firstEvent.id, key)).status, 201);
    assert.equal((await book(otherEvent.id, key)).status, 400);
    assert.equal(await db.booking.count({ where: { eventId: otherEvent.id } }), 0);
  });
  it("returns sold-out and rolls back the failed key", async () => {
    const event = await createEvent(1);
    assert.equal((await book(event.id)).status, 201);
    const key = randomUUID();
    assert.equal((await book(event.id, key)).status, 409);
    assert.equal(await db.idempotency.count({ where: { userId, key } }), 0);
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 0);
  });
  it("allows independent purchases with new keys", async () => {
    const event = await createEvent();
    const first = await book(event.id);
    const second = await book(event.id);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.data.id, second.body.data.id);
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 1);
  });
  it("keeps the same key isolated across users", async () => {
    const otherUser = await registerUser();
    const event = await createEvent();
    const key = randomUUID();
    const first = await book(event.id, key);
    const second = await book(event.id, key, otherUser.token);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.notEqual(first.body.data.id, second.body.data.id);
    assert.equal(second.body.data.userId, otherUser.userId);
  });
  it("creates one booking for simultaneous requests sharing a key", async () => {
    const event = await createEvent();
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 8 }, () => book(event.id, key)));
    assert.equal(responses.filter((res) => res.status === 201).length, 1);
    assert.equal(responses.filter((res) => res.status === 200).length, 7, JSON.stringify(responses.map((res) => res.status)));
    assert.equal(new Set(responses.map((res) => res.body.data?.id)).size, 1);
    assert.equal(await db.booking.count({ where: { eventId: event.id } }), 1);
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 2);
  });
  it("rejects concurrent conflicting payloads for the same key", async () => {
    const firstEvent = await createEvent();
    const secondEvent = await createEvent();
    const key = randomUUID();
    const responses = await Promise.all([book(firstEvent.id, key), book(secondEvent.id, key)]);
    assert.deepEqual(responses.map((res) => res.status).sort(), [201, 400]);
    assert.equal(await db.booking.count({ where: { eventId: { in: [firstEvent.id, secondEvent.id] } } }), 1);
    const events = await db.event.findMany({ where: { id: { in: [firstEvent.id, secondEvent.id] } } });
    assert.equal(events.reduce((total, event) => total + event.remainTickets, 0), 5);
  });
  it("does not oversell five tickets under twenty simultaneous purchases", async () => {
    const event = await createEvent(5);
    const responses = await Promise.all(Array.from({ length: 20 }, () => book(event.id)));
    assert.equal(responses.filter((res) => res.status === 201).length, 5);
    assert.equal(responses.filter((res) => res.status === 409).length, 15, JSON.stringify(responses.map((res) => res.status)));
    assert.equal(await db.booking.count({ where: { eventId: event.id } }), 5);
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 0);
  });
  it("runs the idempotency and 100-request race scripts against a real API", async () => {
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const event = await createEvent();
      assert.match(await runApiScript("idempotency.sh", event.id, { baseUrl }), /PASS: create=201/);
      assert.equal(await db.booking.count({ where: { eventId: event.id } }), 1);
      const raceEvent = await createEvent(5);
      assert.match(await runApiScript("race-condition.sh", raceEvent.id, { baseUrl, count: 100 }), /5 bookings, 95 sold-out responses, 0 tickets remaining/);
      assert.equal(await db.booking.count({ where: { eventId: raceEvent.id } }), 5);
      assert.equal((await db.event.findUnique({ where: { id: raceEvent.id } })).remainTickets, 0);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});

describe("C4 migration with historical data", () => {
  it("preserves cached responses, bookings and inventory while allowing the same key across users", checkLegacyMigration);
});

async function waitForBlockedBy(blockerPid) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const { rows } = await admin.query(
      "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))", [blockerPid]);
    if (rows.length) return rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`No database session was blocked by PID ${blockerPid}`);
}

async function checkRoleChangeBeforePermission(subject) {
  const actor = await provisionUser(subject === "actor" ? "organizer" : "admin");
  const recipient = subject === "actor" ? actor : await provisionUser("organizer");
  const changing = subject === "actor" ? actor : recipient;
  const client = await admin.connect();
  let pending;
  try {
    await client.query("BEGIN");
    const { rows: [{ pid }] } = await client.query("SELECT pg_backend_pid() AS pid");
    await client.query(`UPDATE "${schema}".users SET role = 'buyer' WHERE id = $1`, [changing.userId]);
    const payload = eventPayload(subject === "recipient" ? { organizerId: recipient.userId } : {});
    pending = postEvent(payload, actor.token).then((response) => response);
    await waitForBlockedBy(pid);
    await client.query("COMMIT");
    const response = await pending;
    assert.equal(response.status, subject === "actor" ? 403 : 400, JSON.stringify(response.body));
    assert.equal(await db.event.count({ where: { title: payload.title } }), 0);
  } finally {
    await client.query("ROLLBACK");
    if (pending) await pending;
    client.release(true);
  }
}

async function checkRoleChangeAfterPermission(subject) {
  const actor = await provisionUser(subject === "actor" ? "organizer" : "admin");
  const recipient = subject === "actor" ? actor : await provisionUser("organizer");
  const changing = subject === "actor" ? actor : recipient;
  const payload = eventPayload(subject === "recipient" ? { organizerId: recipient.userId } : {});
  const gate = await admin.connect();
  const changer = await admin.connect();
  const lockKey = Math.floor(Math.random() * 1000000000);
  let createPending;
  let updatePending;
  try {
    await gate.query("SELECT pg_advisory_lock($1::bigint)", [lockKey]);
    const { rows: [{ pid: gatePid }] } = await gate.query("SELECT pg_backend_pid() AS pid");
    await admin.query(`CREATE FUNCTION "${schema}".pause_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.title = '${payload.title}' THEN PERFORM pg_advisory_xact_lock(${lockKey}::bigint); END IF;
        RETURN NEW;
      END $$`);
    await admin.query(`CREATE TRIGGER pause_event_insert BEFORE INSERT ON "${schema}".events
      FOR EACH ROW EXECUTE FUNCTION "${schema}".pause_event_insert()`);
    createPending = postEvent(payload, actor.token).then((response) => response);
    const createPid = await waitForBlockedBy(gatePid);
    updatePending = changer.query(`UPDATE "${schema}".users SET role = 'buyer' WHERE id = $1`, [changing.userId]);
    const updatePid = await waitForBlockedBy(createPid);
    assert.notEqual(updatePid, createPid);
    await gate.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]);
    const response = await createPending;
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.organizerId, recipient.userId);
    await updatePending;
    assert.equal((await db.user.findUnique({ where: { id: changing.userId } })).role, "buyer");
    assert.equal((await postEvent(eventPayload(subject === "recipient" ? { organizerId: recipient.userId } : {}), actor.token)).status,
      subject === "actor" ? 403 : 400);
    assert.equal((await db.event.findUnique({ where: { id: response.body.data.id } })).organizerId, recipient.userId);
  } finally {
    await gate.query("SELECT pg_advisory_unlock_all()");
    if (createPending) await createPending;
    if (updatePending) await updatePending;
    try {
      await admin.query(`DROP TRIGGER IF EXISTS pause_event_insert ON "${schema}".events`);
      await admin.query(`DROP FUNCTION IF EXISTS "${schema}".pause_event_insert()`);
    } finally { gate.release(true); changer.release(true); }
  }
}

describe("Event authorization, ownership and inventory", () => {
  it("rejects anonymous, invalid-token, buyer, unsupported-role and deleted actors without creating events", async () => {
    const initialCount = await db.event.count();
    assert.equal((await postEvent(eventPayload(), null)).status, 401);
    assert.equal((await postEvent(eventPayload(), "invalid-token")).status, 401);
    assert.equal((await postEvent(eventPayload(), token)).status, 403);
    const unsupported = await provisionUser("organizer");
    await db.user.update({ where: { id: unsupported.userId }, data: { role: "unsupported" } });
    assert.equal((await postEvent(eventPayload(), unsupported.token)).status, 403);
    const deleted = await provisionUser("organizer");
    await db.user.delete({ where: { id: deleted.userId } });
    assert.equal((await postEvent(eventPayload(), deleted.token)).status, 401);
    assert.equal(await db.event.count(), initialCount);
  });
  it("assigns organizer ownership and lets an admin create for a different organizer", async () => {
    const own = await postEvent();
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal(own.body.data.organizerId, organizer.userId);
    const delegated = await postEvent(eventPayload({ organizerId: organizer.userId }), administrator.token);
    assert.equal(delegated.status, 201, JSON.stringify(delegated.body));
    assert.equal(delegated.body.data.organizerId, organizer.userId);
    assert.notEqual(delegated.body.data.organizerId, administrator.userId);
    assert.deepEqual(Object.keys(delegated.body.data).sort(),
      ["id", "title", "description", "location", "totalTickets", "remainTickets", "price", "createdAt", "organizerId"].sort());
    assert.equal((await db.event.findUnique({ where: { id: delegated.body.data.id } })).organizerId, organizer.userId);
  });
  it("rejects organizer owner selection and invalid admin recipients atomically", async () => {
    const initialCount = await db.event.count();
    for (const organizerId of [organizer.userId, administrator.userId, randomUUID()]) {
      assert.equal((await postEvent(eventPayload({ organizerId }))).status, 400);
    }
    for (const overrides of [{}, { organizerId: randomUUID() }, { organizerId: userId },
      { organizerId: administrator.userId }, { organizerId: null }, { organizerId: "invalid" }]) {
      assert.equal((await postEvent(eventPayload(overrides), administrator.token)).status, 400);
    }
    assert.equal(await db.event.count(), initialCount);
  });
  it("rejects forbidden fields even when their values appear valid", async () => {
    const initialCount = await db.event.count();
    for (const overrides of [{ role: "organizer" }, { ownerId: organizer.userId }, { unexpected: true },
      ...[-1, 0, 1, 3, 4].map((remainTickets) => ({ remainTickets }))]) {
      assert.equal((await postEvent(eventPayload(overrides))).status, 400, JSON.stringify(overrides));
      assert.equal((await postEvent(eventPayload({ ...overrides, organizerId: organizer.userId }), administrator.token)).status, 400);
    }
    assert.equal(await db.event.count(), initialCount);
  });
  it("rejects invalid capacities and values beyond PostgreSQL int4 without rounding", async () => {
    const initialCount = await db.event.count();
    for (const totalTickets of [undefined, null, "3", 1.5, 0, -1, 2147483648, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await postEvent(eventPayload({ totalTickets }))).status, 400, String(totalTickets));
    }
    assert.equal(await db.event.count(), initialCount);
    for (const totalTickets of [1, 2147483647]) {
      const created = await postEvent(eventPayload({ totalTickets }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.totalTickets, totalTickets);
      assert.equal(created.body.data.remainTickets, totalTickets);
    }
  });
  it("uses the current actor role after promotion and demotion with the same JWT", async () => {
    const promoted = await registerUser();
    assert.equal((await postEvent(eventPayload(), promoted.token)).status, 403);
    await db.user.update({ where: { id: promoted.userId }, data: { role: "organizer" } });
    assert.equal((await postEvent(eventPayload(), promoted.token)).status, 201);
    await db.user.update({ where: { id: promoted.userId }, data: { role: "buyer" } });
    assert.equal((await postEvent(eventPayload(), promoted.token)).status, 403);
    const demotedAdmin = await provisionUser("admin");
    await db.user.update({ where: { id: demotedAdmin.userId }, data: { role: "organizer" } });
    assert.equal((await postEvent(eventPayload({ organizerId: organizer.userId }), demotedAdmin.token)).status, 400);
  });
  for (const subject of ["actor", "recipient"]) {
    it(`uses the changed ${subject} role when create waits before the permission point`, async () => {
      await checkRoleChangeBeforePermission(subject);
    });
    it(`keeps accepted creation when the ${subject} role change waits after the permission point`, async () => {
      await checkRoleChangeAfterPermission(subject);
    });
  }
  it("exposes only public event fields to every catalog reader", async () => {
    const event = await createEvent();
    for (const accessToken of [null, token, organizer.token, administrator.token]) {
      let req = request(app).get("/events");
      if (accessToken) req = req.set("Authorization", `Bearer ${accessToken}`);
      const response = await req;
      assert.equal(response.status, 200);
      const listed = response.body.find((entry) => entry.id === event.id);
      assert.ok(listed);
      assert.deepEqual(Object.keys(listed).sort(),
        ["id", "title", "description", "location", "totalTickets", "remainTickets", "price", "createdAt"].sort());
    }
  });
  it("keeps public signup unable to assign privileged roles", async () => {
    for (const role of ["organizer", "admin"]) {
      const email = `signup-${randomUUID()}@example.com`;
      assert.equal((await request(app).post("/auth/register").send({ email, password, role })).status, 400);
      assert.equal(await db.user.count({ where: { email } }), 0);
    }
  });
  it("enforces database inventory checks, owner requirement and foreign keys on direct writes", async () => {
    const event = await createEvent();
    const client = await admin.connect();
    try {
      for (const [total, remain] of [[0, 0], [-1, 0], [3, -1], [3, 4]]) {
        await assert.rejects(() => client.query(`UPDATE "${schema}".events SET total_tickets=$1, remain_tickets=$2 WHERE id=$3`,
          [total, remain, event.id]), { code: "23514" });
        await assert.rejects(() => client.query(`INSERT INTO "${schema}".events
          (id, title, total_tickets, remain_tickets, price, organizer_id) VALUES ($1, 'Invalid inventory', $2, $3, 1, $4)`,
          [randomUUID(), total, remain, organizer.userId]), { code: "23514" });
      }
      for (const remain of [0, 3]) {
        await client.query(`UPDATE "${schema}".events SET remain_tickets=$1 WHERE id=$2`, [remain, event.id]);
      }
      await assert.rejects(() => client.query(`INSERT INTO "${schema}".events
        (id, title, total_tickets, remain_tickets, price) VALUES ($1, 'New ownerless', 1, 1, 1)`, [randomUUID()]), { code: "23502" });
      await assert.rejects(() => client.query(`UPDATE "${schema}".events SET organizer_id=NULL WHERE id=$1`, [event.id]), { code: "23502" });
      await assert.rejects(() => client.query(`UPDATE "${schema}".events SET organizer_id=$1 WHERE id=$2`, [randomUUID(), event.id]), { code: "23503" });
      await assert.rejects(() => client.query(`DELETE FROM "${schema}".users WHERE id=$1`, [organizer.userId]), { code: "23503" });
    } finally { client.release(true); }
  });
  it("lists and books a legacy ownerless event without claiming it", async () => {
    const id = randomUUID();
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      // Synthesize pre-migration legacy data in the isolated test schema only.
      // The dedicated migration fixture below proves actual historical preservation.
      await client.query(`ALTER TABLE "${schema}".events DISABLE TRIGGER events_require_owner`);
      await client.query(`INSERT INTO "${schema}".events
        (id, title, total_tickets, remain_tickets, price) VALUES ($1, 'Legacy ownerless', 3, 2, 1)`, [id]);
      await client.query(`ALTER TABLE "${schema}".events ENABLE TRIGGER events_require_owner`);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(true); }
    const catalog = await request(app).get("/events");
    assert.ok(catalog.body.some((event) => event.id === id));
    const key = randomUUID();
    assert.equal((await book(id, key)).status, 201);
    assert.equal((await book(id, key)).status, 200);
    const stored = await db.event.findUnique({ where: { id } });
    assert.equal(stored.organizerId, null);
    assert.equal(stored.remainTickets, 1);
    assert.equal(await db.booking.count({ where: { eventId: id } }), 1);
  });
  it("rolls back a failed event insert without creating an ownerless or partial event", async () => {
    const payload = eventPayload();
    await admin.query(`CREATE FUNCTION "${schema}".reject_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected event insert failure'; END $$`);
    await admin.query(`CREATE TRIGGER reject_event_insert BEFORE INSERT ON "${schema}".events
      FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_event_insert()`);
    try {
      assert.equal((await postEvent(payload)).status, 500);
      assert.equal(await db.event.count({ where: { title: payload.title } }), 0);
    } finally {
      await admin.query(`DROP TRIGGER reject_event_insert ON "${schema}".events`);
      await admin.query(`DROP FUNCTION "${schema}".reject_event_insert()`);
    }
    assert.equal((await postEvent(payload)).status, 201);
  });
});

async function checkEventFoundationMigration(invalid = false) {
  const client = await admin.connect();
  const fixtureSchema = `Migration_${randomUUID().replaceAll("-", "")}`;
  try {
    await createLegacySchema(client, fixtureSchema, eventFoundationMigration);
    const ids = await seedLegacyKey(client);
    if (invalid) await client.query("UPDATE events SET remain_tickets = total_tickets + 1 WHERE id = $1", [ids.event]);
    const beforeEvents = (await client.query("SELECT * FROM events ORDER BY id")).rows;
    const beforeBookings = (await client.query("SELECT * FROM bookings ORDER BY id")).rows;
    const beforeKeys = (await client.query("SELECT * FROM idempotency_keys ORDER BY key")).rows;
    const migration = readFileSync(path.join(__dirname, "../prisma/migrations", eventFoundationMigration, "migration.sql"), "utf8");
    if (invalid) {
      await assert.rejects(() => client.query(migration), { code: "23514" });
      await client.query("ROLLBACK");
      const columns = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='events'", [fixtureSchema]);
      assert.ok(!columns.rows.some((row) => row.column_name === "organizer_id"));
      assert.deepEqual((await client.query("SELECT * FROM events ORDER BY id")).rows, beforeEvents);
    } else {
      await client.query(migration);
      const expectedEvents = beforeEvents.map((event) => ({ ...event, organizer_id: null }));
      assert.deepEqual((await client.query("SELECT * FROM events ORDER BY id")).rows, expectedEvents);
      const constraints = await client.query("SELECT convalidated FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c'", [`"${fixtureSchema}".events`]);
      assert.equal(constraints.rows.length, 2);
      assert.ok(constraints.rows.every((entry) => entry.convalidated));
      await client.query("UPDATE events SET remain_tickets = 1 WHERE id = $1", [ids.event]);
      assert.equal((await client.query("SELECT organizer_id FROM events WHERE id=$1", [ids.event])).rows[0].organizer_id, null);
    }
    assert.deepEqual((await client.query("SELECT * FROM bookings ORDER BY id")).rows, beforeBookings);
    assert.deepEqual((await client.query("SELECT * FROM idempotency_keys ORDER BY key")).rows, beforeKeys);
  } finally {
    try { await client.query("ROLLBACK"); await client.query(`DROP SCHEMA IF EXISTS "${fixtureSchema}" CASCADE`); }
    finally { client.release(true); }
  }
}

describe("Event foundation migration with historical data", () => {
  it("preserves legacy ownerless events, bookings and cached idempotency responses", async () => {
    await checkEventFoundationMigration();
  });
  it("stops and rolls back on invalid legacy inventory without silently repairing data", async () => {
    await checkEventFoundationMigration(true);
  });
});

function bookingRequest(method, id, accessToken = token, body) {
  const req = request(app)[method](`/bookings/${id}${method === "post" ? "/cancel" : ""}`);
  if (accessToken) req.set("Authorization", `Bearer ${accessToken}`);
  return body === undefined ? req : req.send(body);
}

function patchEvent(id, payload, accessToken = organizer.token) {
  const req = request(app).patch(`/events/${id}`).send(payload);
  return accessToken ? req.set("Authorization", `Bearer ${accessToken}`) : req;
}

describe("Exact prices, keyset catalog and object access control", () => {
  it("stores and returns exact two-place decimal prices without Number rounding", async () => {
    for (const [price, expected] of [["0.10", "0.10"], ["123.45", "123.45"], ["9999999999.99", "9999999999.99"], [0.1, "0.10"]]) {
      const res = await postEvent(eventPayload({ price }));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.price, expected);
      assert.equal((await db.event.findUnique({ where: { id: res.body.data.id } })).price.toFixed(2), expected);
    }
    const before = await db.event.count();
    for (const price of ["0.001", "-1.00", "10000000000.00", "1e2", "01.00", "NaN", "Infinity", "1.00\n", " 1.00", "1.00 ", 0.1 + 0.2, null]) {
      assert.equal((await postEvent(eventPayload({ price }))).status, 400, String(price));
    }
    assert.equal(await db.event.count(), before);
  });
  it("paginates tied creation times without duplicates or missing fixture events", async () => {
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push((await createEvent()).id);
    const tied = new Date("2090-01-01T00:00:00.123Z");
    await db.event.updateMany({ where: { id: { in: ids } }, data: { createdAt: tied } });
    const expected = [...ids].sort().reverse();
    const seen = [];
    let cursor;
    for (let i = 0; i < 4; i++) {
      let req = request(app).get("/events").query({ limit: 2 });
      if (cursor) req = req.query({ cursor });
      const page = await req;
      assert.equal(page.status, 200);
      assert.ok(page.body.length <= 2);
      for (const row of page.body) {
        assert.equal(row.organizerId, undefined);
        if (ids.includes(row.id)) seen.push(row.id);
      }
      cursor = page.headers["x-next-cursor"];
      assert.ok(cursor, "More rows exist after the tied fixtures");
    }
    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, ids.length);
    // Keep unrelated catalog assertions independent of these future-dated fixtures.
    await db.event.updateMany({ where: { id: { in: ids } }, data: { createdAt: new Date() } });
  });
  it("rejects malformed catalog limits and cursor payloads before database queries", async () => {
    const invalidCursor = Buffer.from(JSON.stringify({ createdAt: "2090-02-30T00:00:00.000Z", id: randomUUID() })).toString("base64url");
    for (const query of [{ limit: 0 }, { limit: 101 }, { limit: "2.5" }, { limit: "-1" },
      { cursor: "bad!" }, { cursor: invalidCursor }, { cursor: "" }, { unexpected: 1 }]) {
      assert.equal((await request(app).get("/events").query(query)).status, 400, JSON.stringify(query));
    }
  });
  it("reads a real private booking only for its owner or the current admin", async () => {
    const event = await createEvent();
    const created = await book(event.id);
    assert.equal(created.status, 201);
    const id = created.body.data.id;
    const other = await registerUser();
    assert.equal((await bookingRequest("get", id, null)).status, 401);
    assert.equal((await bookingRequest("get", id, other.token)).status, 404);
    assert.equal((await bookingRequest("get", id, organizer.token)).status, 404);
    const own = await bookingRequest("get", id);
    assert.equal(own.status, 200);
    assert.deepEqual(own.body.data, created.body.data);
    assert.equal((await bookingRequest("get", id, administrator.token)).status, 200);
    assert.equal(await db.booking.count({ where: { id } }), 1, "Denied request targets an existing booking");
  });
  it("prevents cross-organizer metadata updates and rejects ownership/inventory changes", async () => {
    const event = await createEvent();
    const other = await provisionUser("organizer");
    const original = await db.event.findUnique({ where: { id: event.id } });
    assert.equal((await patchEvent(event.id, { title: "Spoof" }, other.token)).status, 404);
    assert.equal((await patchEvent(event.id, { title: "Spoof" }, token)).status, 403);
    assert.equal((await patchEvent(event.id, { title: "Spoof" }, null)).status, 401);
    for (const body of [{ organizerId: other.userId }, { remainTickets: 1 }, { totalTickets: 9 }, {}, { role: "admin" }]) {
      assert.equal((await patchEvent(event.id, body)).status, 400);
    }
    assert.deepEqual(await db.event.findUnique({ where: { id: event.id } }), original);
    const updated = await patchEvent(event.id, { title: "Owner updated", description: null, location: "Lab", price: "12.34" });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.price, "12.34");
    assert.equal(updated.body.data.organizerId, organizer.userId);
    assert.equal((await patchEvent(event.id, { title: "Admin updated" }, administrator.token)).status, 200);
  });
  it("uses current roles for management and does not let organizers claim legacy events", async () => {
    const event = await createEvent();
    await db.user.update({ where: { id: organizer.userId }, data: { role: "buyer" } });
    try { assert.equal((await patchEvent(event.id, { title: "Old claim" })).status, 403); }
    finally { await db.user.update({ where: { id: organizer.userId }, data: { role: "organizer" } }); }
    const legacy = await db.event.findFirst({ where: { organizerId: null } });
    assert.ok(legacy);
    assert.equal((await patchEvent(legacy.id, { title: "Claim" })).status, 404);
    assert.equal((await patchEvent(legacy.id, { title: "Legacy admin edit" }, administrator.token)).status, 200);
    assert.equal((await db.event.findUnique({ where: { id: legacy.id } })).organizerId, null);
  });
  it("denies another user's cancellation without changing booking, key or inventory", async () => {
    const event = await createEvent();
    const key = randomUUID();
    const created = await book(event.id, key);
    const other = await registerUser();
    const before = await db.booking.findUnique({ where: { id: created.body.data.id } });
    const saved = await db.idempotency.findUnique({ where: { userId_key: { userId, key } } });
    assert.equal((await bookingRequest("post", before.id, null)).status, 401);
    assert.equal((await bookingRequest("post", before.id, other.token)).status, 404);
    assert.equal((await bookingRequest("post", before.id, organizer.token)).status, 404);
    assert.deepEqual(await db.booking.findUnique({ where: { id: before.id } }), before);
    assert.deepEqual(await db.idempotency.findUnique({ where: { userId_key: { userId, key } } }), saved);
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 2);
  });
  it("restores one ticket once under simultaneous cancellation and preserves creation replay", async () => {
    const event = await createEvent(1);
    const key = randomUUID();
    const created = await book(event.id, key);
    const id = created.body.data.id;
    const responses = await Promise.all(Array.from({ length: 8 }, () => bookingRequest("post", id)));
    assert.ok(responses.every((res) => res.status === 200), JSON.stringify(responses.map((res) => res.status)));
    assert.ok(responses.every((res) => res.body.data.status === "CANCELLED"));
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 1);
    const replay = await book(event.id, key);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, created.body, "Creation retry remains the original cached operation snapshot");
    assert.equal((await bookingRequest("get", id)).body.data.status, "CANCELLED");
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 1);
    assert.equal((await book(event.id)).status, 201);
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 0);
  });
  it("allows admin cancellation but immediately loses that access after demotion", async () => {
    const event = await createEvent();
    const created = await book(event.id);
    const id = created.body.data.id;
    await db.user.update({ where: { id: administrator.userId }, data: { role: "organizer" } });
    try {
      assert.equal((await bookingRequest("get", id, administrator.token)).status, 404);
      assert.equal((await bookingRequest("post", id, administrator.token)).status, 404);
    } finally { await db.user.update({ where: { id: administrator.userId }, data: { role: "admin" } }); }
    const res = await bookingRequest("post", id, administrator.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, "CANCELLED");
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 3);
  });
  it("rolls back cancellation and its stock restoration when the inventory write fails", async () => {
    const event = await createEvent(1);
    const created = await book(event.id);
    const id = created.body.data.id;
    await installInventoryFailure(event.id);
    try {
      assert.equal((await bookingRequest("post", id)).status, 500);
      assert.equal((await db.booking.findUnique({ where: { id } })).status, "CONFIRMED");
      assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 0);
    } finally { await removeInventoryFailure(); }
    assert.equal((await bookingRequest("post", id)).status, 200);
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 1);
  });
  it("rejects inconsistent stock and unsupported booking states without silent repairs", async () => {
    const event = await createEvent(1);
    const created = await book(event.id);
    const id = created.body.data.id;
    await db.event.update({ where: { id: event.id }, data: { remainTickets: 1 } });
    assert.equal((await bookingRequest("post", id)).status, 409);
    assert.equal((await db.booking.findUnique({ where: { id } })).status, "CONFIRMED");
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 1);
    await db.event.update({ where: { id: event.id }, data: { remainTickets: 0 } });
    await db.booking.update({ where: { id }, data: { status: "UNSUPPORTED" } });
    assert.equal((await bookingRequest("post", id)).status, 409);
    assert.equal((await db.booking.findUnique({ where: { id } })).status, "UNSUPPORTED");
    assert.equal((await db.event.findUnique({ where: { id: event.id } })).remainTickets, 0);
    assert.equal((await patchEvent("invalid", { title: "Invalid ID" })).status, 400);
    assert.equal((await patchEvent(randomUUID(), { title: "Missing event" })).status, 404);
  });
  it("serializes cancellation against a new purchase without losing or inventing tickets", async () => {
    const event = await createEvent(1);
    const created = await book(event.id);
    const [cancel, purchase] = await Promise.all([bookingRequest("post", created.body.data.id), book(event.id)]);
    assert.equal(cancel.status, 200);
    assert.ok([201, 409].includes(purchase.status));
    const remaining = (await db.event.findUnique({ where: { id: event.id } })).remainTickets;
    const confirmed = await db.booking.count({ where: { eventId: event.id, status: "CONFIRMED" } });
    assert.equal(remaining + confirmed, 1);
    assert.equal((await db.booking.findUnique({ where: { id: created.body.data.id } })).status, "CANCELLED");
  });
  it("rejects unsupported/deleted actors, invalid IDs and cancellation payload injection", async () => {
    const event = await createEvent();
    const created = await book(event.id);
    const id = created.body.data.id;
    const actor = await registerUser();
    await db.user.update({ where: { id: actor.userId }, data: { role: "unsupported" } });
    assert.equal((await book(event.id, randomUUID(), actor.token)).status, 403);
    assert.equal((await bookingRequest("get", id, actor.token)).status, 403);
    assert.equal((await bookingRequest("post", id, actor.token)).status, 403);
    await db.user.delete({ where: { id: actor.userId } });
    assert.equal((await book(event.id, randomUUID(), actor.token)).status, 401);
    assert.equal((await bookingRequest("get", id, actor.token)).status, 401);
    assert.equal((await bookingRequest("post", id, actor.token)).status, 401);
    assert.equal((await bookingRequest("get", "invalid")).status, 400);
    assert.equal((await bookingRequest("post", "invalid")).status, 400);
    assert.equal((await bookingRequest("post", randomUUID())).status, 404);
    assert.equal((await bookingRequest("post", id, token, { userId: organizer.userId })).status, 400);
    assert.equal((await db.booking.findUnique({ where: { id } })).status, "CONFIRMED");
  });
});
