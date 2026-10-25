const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { mkdir, writeFile, readFile, rm } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const execute = promisify(execFile);

async function unusedPort() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitReady(baseUrl, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API process exited ${child.exitCode}`);
    try { if ((await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) })).status === 200) return; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`API readiness deadline reached: ${baseUrl}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timer);
}

async function api(baseUrl, endpoint, token, body, key) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  return { status: response.status, body: await response.json() };
}

async function snapshot(client, eventId) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const { rows: [event] } = await client.query("SELECT id,total_tickets,remain_tickets FROM events WHERE id=$1", [eventId]);
    const { rows: bookings } = await client.query("SELECT id,seat_id,reservation_id,status FROM bookings WHERE event_id=$1 ORDER BY id", [eventId]);
    const { rows: reservations } = await client.query("SELECT id,seat_id,status,expires_at FROM reservations WHERE event_id=$1 ORDER BY id", [eventId]);
    const confirmed = bookings.filter((booking) => booking.status === "CONFIRMED");
    const held = reservations.filter((reservation) => reservation.status === "HELD");
    assert.equal(event.remain_tickets + held.length + confirmed.length, event.total_tickets);
    assert.ok(event.remain_tickets >= 0 && event.remain_tickets <= event.total_tickets);
    assert.equal(new Set(confirmed.map((booking) => booking.seat_id)).size, confirmed.length);
    assert.equal(new Set(bookings.map((booking) => booking.reservation_id)).size, bookings.length);
    await client.query("COMMIT");
    return { event, bookings, reservations, invariantHolds: true };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function main() {
  const configured = process.env.TEST_DATABASE_URL;
  assert.ok(configured, "Set TEST_DATABASE_URL to a database ending in _test");
  const base = new URL(configured);
  assert.match(decodeURIComponent(base.pathname), /_test$/);
  const redisUrl = new URL(process.env.TEST_REDIS_URL || "redis://127.0.0.1:56379");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(redisUrl.hostname) && redisUrl.port === "56379", "Load cache must use the dedicated loopback test Redis on port 56379");
  const counts = (process.env.LOAD_INSTANCES || "1,2").split(",").map(Number);
  assert.ok(counts.every((value) => [1, 2].includes(value)), "LOAD_INSTANCES may contain 1,2 only");
  const runId = `load-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const destination = path.resolve("docs/reports/booking-c", runId);
  await mkdir(destination, { recursive: true });
  const admin = new Pool({ connectionString: configured });
  const schema = `Load_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(configured);
  url.searchParams.set("schema", schema);
  url.searchParams.set("options", `-c search_path="${schema}"`);
  const secret = "booking-load-test-only-secret";
  const children = [];
  const results = [];
  const sourceFiles = (await execute("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src", "prisma", "tests", "package.json", "package-lock.json", "tsconfig.json"])).stdout.trim().split("\n");
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.filter(Boolean).map(async (file) => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));
  let client;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const migrate = await execute(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url.toString() }, timeout: 30000 });
    await writeFile(path.join(destination, "migration.log"), migrate.stdout + migrate.stderr);
    client = await admin.connect();
    await client.query(`SET search_path TO "${schema}"`);
    const organizerId = randomUUID();
    const buyerId = randomUUID();
    for (const [id, role] of [[organizerId, "organizer"], [buyerId, "buyer"]]) {
      await client.query("INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,$4)", [id, `${id}@load.test`, "test-fixture-no-login", role]);
    }
    const token = jwt.sign({ userId: buyerId, role: "buyer" }, secret, { expiresIn: "1h" });
    const organizerToken = jwt.sign({ userId: organizerId, role: "organizer" }, secret, { expiresIn: "1h" });
    const endpoints = [];
    for (let i = 0; i < Math.max(...counts); i++) {
      const port = await unusedPort();
      const child = spawn(process.execPath, ["dist/index.js"], {
        env: { ...process.env, DATABASE_URL: url.toString(), JWT_SECRET: secret, PORT: String(port), NODE_ENV: "test", ENABLE_TEST_UI: "false", RESERVATION_TTL_SECONDS: "300", REDIS_URL: redisUrl.toString() },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      let log = "";
      child.stdout.on("data", (data) => { log += data; });
      child.stderr.on("data", (data) => { log += data; });
      child.on("exit", () => writeFile(path.join(destination, `api-${i + 1}.log`), log));
      const endpoint = `http://127.0.0.1:${port}`;
      endpoints.push(endpoint);
      await waitReady(endpoint, child);
    }
    for (const instanceCount of counts) {
      for (const mode of ["confirm", "hold"]) {
        const name = `${instanceCount}-instance-${mode}`;
        const created = await api(endpoints[0], "/events", organizerToken, { title: `${runId}-${name}`, totalTickets: 100, price: "10.00" });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const eventId = created.body.data.id;
        const listed = await api(endpoints[0], `/events/${eventId}/seats`, token);
        assert.equal(listed.status, 200, JSON.stringify(listed.body));
        const seats = Array.isArray(listed.body) ? listed.body : listed.body.data;
        assert.equal(seats.length, 100);
        const reservations = [];
        if (mode === "confirm") {
          for (const seat of seats) {
            const reservationId = randomUUID();
            const hold = await api(endpoints[0], "/bookings/hold", token, { eventId, seatId: seat.id, reservationId });
            assert.equal(hold.status, 201, JSON.stringify(hold.body));
            reservations.push({ reservationId, seatId: seat.id });
          }
        }
        const fixture = { runId, mode, baseUrls: endpoints.slice(0, instanceCount), token, eventId, seats, reservations, uuidPrefix: randomUUID().slice(0, 24) };
        const fixturePath = path.join(destination, `${name}-fixture.secret.json`);
        await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
        let execution;
        try {
          execution = await execute(process.env.K6_BIN || "k6", ["run", "--quiet", "--out", `json=${path.join(destination, `${name}-raw.jsonl`)}`, "tests/k6/booking-load.js"], {
            env: { ...process.env, FIXTURE_PATH: fixturePath, SUMMARY_PATH: path.join(destination, `${name}-summary.json`) },
            timeout: 150000, maxBuffer: 4 * 1024 * 1024,
          }).catch((error) => ({ stdout: error.stdout || "", stderr: error.stderr || "", error }));
        } finally { await rm(fixturePath, { force: true }); }
        await writeFile(path.join(destination, `${name}-k6.log`), execution.stdout + execution.stderr);
        const state = await snapshot(client, eventId);
        await writeFile(path.join(destination, `${name}-database.json`), JSON.stringify(state, null, 2));
        const summary = JSON.parse(await readFile(path.join(destination, `${name}-summary.json`), "utf8"));
        const metrics = Object.fromEntries(Object.entries(summary.metrics).filter(([key]) => key.startsWith("instance_") || ["http_reqs", "iterations", "booking_created", "business_conflict", "unexpected_outcome", "hold_created"].includes(key)).map(([key, metric]) => [key, metric.values]));
        const result = { name, instanceCount, mode, eventId, seedHttpRequests: mode === "confirm" ? 102 : 2, workloadHttpRequests: mode === "confirm" ? 5000 : 5100, metrics, database: { capacity: state.event.total_tickets, remaining: state.event.remain_tickets, bookings: state.bookings.length, held: state.reservations.filter((r) => r.status === "HELD").length } };
        results.push(result);
        await writeFile(path.join(destination, "results.json"), JSON.stringify(results, null, 2));
        assert.ok(!execution.error, `${name}: k6 thresholds failed; inspect ${destination}`);
        assert.equal(state.bookings.length, 100);
        assert.equal(state.event.remain_tickets, 0);
        for (let i = 0; i < instanceCount; i++) assert.ok(metrics[`instance_${i + 1}_requests`].count > 0);
        console.log(`PASS ${name}: 100 bookings, 0 tickets; ${result.workloadHttpRequests} workload HTTP requests`);
      }
    }
    const { stdout: k6 } = await execute(process.env.K6_BIN || "k6", ["version"]);
    const { stdout: sha } = await execute("git", ["rev-parse", "HEAD"]);
    const { stdout: diff } = await execute("git", ["diff", "--stat"]);
    const { rows: [postgres] } = await client.query("SELECT version() AS version");
    await writeFile(path.join(destination, "manifest.json"), JSON.stringify({ runId, at: new Date().toISOString(), sha: sha.trim(), dirtyDiff: diff, sourceHashesAtStart: sourceHashes, node: process.version, k6: k6.trim(), postgres: postgres.version, os: `${os.platform()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length, memoryBytes: os.totalmem(), configuration: { vus: 100, iterationsPerVu: 50, maxDurationSeconds: 120, requestTimeoutSeconds: 20, ttlSeconds: 300, isolation: "READ COMMITTED", pgPoolMaxPerApi: 10, lockTimeoutMs: Number(process.env.BOOKING_LOCK_TIMEOUT_MS || 1000), transactionTimeoutMs: Number(process.env.BOOKING_TRANSACTION_TIMEOUT_MS || 5000), retryDeadlineMs: Number(process.env.BOOKING_RETRY_DEADLINE_MS || 10000), retryAttempts: Number(process.env.BOOKING_RETRY_ATTEMPTS || 3), apiPids: children.map((child) => child.pid), database: `${base.hostname}:${base.port}${base.pathname}`, schema }, command: "TEST_DATABASE_URL=<test-db> node tests/booking-load.js", results }, null, 2));
    console.log(`PASS: C6 real-API load verified. Evidence: ${destination}`);
  } finally {
    await Promise.all(children.map(stop));
    if (client) { await client.query("RESET search_path"); client.release(); }
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
