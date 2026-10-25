const assert = require("node:assert/strict");
const { randomUUID, randomInt } = require("node:crypto");
const { readdirSync, readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const supertest = require("supertest");

const root = path.join(__dirname, "../..");
const migrationsDirectory = path.join(root, "prisma/migrations");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function recordEvidence(name, value) {
  if (!process.env.BOOKING_EVIDENCE_DIR) return;
  const directory = path.resolve(process.env.BOOKING_EVIDENCE_DIR);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${name}.json`), JSON.stringify({ recordedAt: new Date().toISOString(), ...value }, null, 2));
}

async function until(check, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { last = error; }
    await pause(20);
  }
  assert.fail(`${description} timed out${last ? `: ${last.message}` : ""}`);
}

function testDatabaseUrl() {
  assert.ok(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL is required");
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.match(decodeURIComponent(url.pathname), /_test$/, "Only a database ending in _test is allowed");
  return url;
}

function migrationFiles() {
  return readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function migrate(client, names = migrationFiles()) {
  for (const name of names) {
    await client.query(readFileSync(path.join(migrationsDirectory, name, "migration.sql"), "utf8"));
  }
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  await closed;
  clearTimeout(timer);
}

async function standaloneApi(databaseUrl, extra = {}) {
  const port = await unusedPort();
  const child = spawn(process.execPath, [path.join(root, "dist/index.js")], {
    cwd: root, env: { ...process.env, NODE_ENV: "test", ENABLE_TEST_UI: "false", DATABASE_URL: databaseUrl, PORT: String(port), ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const address = `http://127.0.0.1:${port}`;
  try {
    await until(async () => {
      assert.equal(child.exitCode, null, output);
      return (await fetch(`${address}/health`)).status === 200;
    }, "Standalone API starts");
    return { child, address };
  } catch (error) { await stopChild(child); throw error; }
}

async function createFixture() {
  const schema = `Reservation_${randomUUID().replaceAll("-", "")}`;
  const url = testDatabaseUrl();
  const admin = new Pool({ connectionString: url.toString() });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set("schema", schema);
  url.searchParams.set("options", `-c search_path="${schema}" -c statement_timeout=15000`);
  const pool = new Pool({ connectionString: url.toString() });
  const client = await pool.connect();
  try { await migrate(client); } finally { client.release(); }
  process.env.DATABASE_URL = url.toString();
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "reservation-integration-secret";
  process.env.ENABLE_TEST_UI = "false";
  process.env.RESERVATION_TTL_SECONDS = "300";
  process.env.BOOKING_LOCK_TIMEOUT_MS = "2000";
  process.env.BOOKING_TRANSACTION_TIMEOUT_MS = "10000";
  process.env.BOOKING_RETRY_DEADLINE_MS = "15000";
  process.env.REDIS_URL = process.env.TEST_REDIS_URL || "redis://127.0.0.1:56379";
  const redisUrl = new URL(process.env.REDIS_URL);
  assert.ok(["127.0.0.1", "localhost"].includes(redisUrl.hostname) && redisUrl.port === "56379",
    "Redis fault tests require the isolated Compose test-redis endpoint on loopback:56379");
  const { app } = require("../../dist/app");
  const { db } = require("../../dist/configs/db");
  const { ReservationService } = require("../../dist/services/reservation.service");
  const { closeReservationCache } = require("../../dist/configs/redis");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = () => supertest(server);
  const children = new Set();

  async function user(role = "buyer") {
    const id = randomUUID();
    await pool.query("INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,'test-only',$3)", [id, `${id}@example.com`, role]);
    return { id, token: jwt.sign({ userId: id, role }, process.env.JWT_SECRET, { expiresIn: "1h" }) };
  }
  const buyer = await user();
  const other = await user();
  const organizer = await user("organizer");
  const administrator = await user("admin");

  async function event(capacity = 3) {
    const response = await request().post("/events").set("Authorization", `Bearer ${organizer.token}`)
      .send({ title: `Reservation ${randomUUID()}`, totalTickets: capacity, price: "100.00" });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const created = response.body.data;
    const { rows: seats } = await pool.query("SELECT * FROM seats WHERE event_id=$1 ORDER BY number", [created.id]);
    assert.equal(seats.length, capacity, "Every event creates its seats atomically");
    return { ...created, seats };
  }

  function hold(target, actor = buyer, overrides = {}) {
    const input = { eventId: target.id, seatId: target.seats[0].id, reservationId: randomUUID(), ...overrides };
    return { input, response: request().post("/bookings/hold").set("Authorization", `Bearer ${actor.token}`).send(input) };
  }

  async function held(target, actor = buyer, overrides = {}) {
    const attempt = hold(target, actor, overrides);
    const response = await attempt.response;
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { input: attempt.input, data: response.body.data };
  }

  function confirm(input, key = randomUUID(), actor = buyer, target = server) {
    return supertest(target).post("/bookings").set("Authorization", `Bearer ${actor.token}`)
      .set("Idempotency-Key", key).send(input);
  }

  async function invariant(eventId) {
    const { rows: [snapshot] } = await pool.query(`SELECT e.total_tickets::int AS total, e.remain_tickets::int AS remaining,
      (SELECT count(*)::int FROM reservations r WHERE r.event_id=e.id AND r.status='HELD') AS held,
      (SELECT count(*)::int FROM bookings b WHERE b.event_id=e.id AND b.status='CONFIRMED') AS booked,
      (SELECT count(DISTINCT seat_id)::int FROM bookings b WHERE b.event_id=e.id AND b.status='CONFIRMED') AS distinct_seats
      FROM events e WHERE e.id=$1`, [eventId]);
    assert.ok(snapshot);
    assert.equal(snapshot.remaining + snapshot.held + snapshot.booked, snapshot.total, JSON.stringify(snapshot));
    assert.ok(snapshot.remaining >= 0 && snapshot.remaining <= snapshot.total, JSON.stringify(snapshot));
    assert.equal(snapshot.booked, snapshot.distinct_seats, "No duplicate confirmed seat");
    return snapshot;
  }

  async function expire(id) {
    await pool.query("UPDATE reservations SET created_at=clock_timestamp()-interval '2 minutes', expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
  }

  async function trigger(table, eventId, action, timing = "BEFORE") {
    assert.match(eventId, /^[\da-f-]{36}$/i);
    assert.ok(["bookings", "reservations", "events", "idempotency_keys"].includes(table));
    const name = `test_${randomUUID().replaceAll("-", "")}`;
    const condition = table === "events" ? `NEW.id = '${eventId}'` : table === "idempotency_keys" ? "TRUE" : `NEW.event_id = '${eventId}'`;
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${action}; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${name} ${timing} INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    return async () => { await pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`); await pool.query(`DROP FUNCTION IF EXISTS ${name}()`); };
  }

  async function gate(table, eventId, timing = "BEFORE") {
    const connection = await pool.connect();
    const key = randomInt(1000000000);
    await connection.query("SELECT pg_advisory_lock($1::bigint)", [key]);
    const { rows: [{ pid }] } = await connection.query("SELECT pg_backend_pid() AS pid");
    const remove = await trigger(table, eventId, `PERFORM pg_advisory_xact_lock(${key}::bigint)`, timing);
    return {
      wait: () => until(async () => {
        const { rows } = await pool.query("SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))", [pid]);
        return rows.length > 0;
      }, "Transaction reaches the database fault gate"),
      async open() { await connection.query("SELECT pg_advisory_unlock($1::bigint)", [key]); },
      async close() { await connection.query("SELECT pg_advisory_unlock_all()"); await remove(); connection.release(); },
    };
  }

  async function child(entry, extra = {}) {
    const processChild = spawn(process.execPath, [path.join(root, entry)], { cwd: root, env: { ...process.env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    processChild.stdout.on("data", (chunk) => { output += chunk; });
    processChild.stderr.on("data", (chunk) => { output += chunk; });
    processChild.output = () => output;
    children.add(processChild);
    return processChild;
  }

  async function api() {
    const port = await unusedPort();
    const processChild = await child("dist/index.js", { PORT: String(port) });
    const address = `http://127.0.0.1:${port}`;
    await until(async () => {
      assert.equal(processChild.exitCode, null, processChild.output());
      return (await fetch(`${address}/health`)).status === 200;
    }, "API process starts");
    return { child: processChild, address };
  }

  async function close() {
    for (const processChild of children) await stopChild(processChild);
    await new Promise((resolve) => server.close(resolve));
    await closeReservationCache();
    await db.$disconnect();
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }

  return { schema, url, pool, admin, app, db, server, baseUrl, request, user, buyer, other, organizer, administrator,
    event, hold, held, confirm, invariant, expire, trigger, gate, child, api, close, service: ReservationService };
}

module.exports = { createFixture, testDatabaseUrl, migrationFiles, migrate, migrationsDirectory, until, pause, stopChild, recordEvidence, standaloneApi };
