const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { randomBytes, randomUUID } = require("node:crypto");
const { existsSync, mkdirSync, realpathSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { Pool } = require("pg");

const execute = promisify(execFile);
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const root = path.resolve(__dirname, "..");

function configuration() {
  const image = process.env.IMAGE_REF;
  const migrationImage = process.env.MIGRATION_IMAGE_REF;
  for (const value of [image, migrationImage]) {
    assert.match(value || "", /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/, "Set explicit IMAGE_REF and MIGRATION_IMAGE_REF");
  }
  const installed = ["/usr/local/bin/docker", "/usr/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"];
  const executable = process.env.DOCKER_BIN || installed.find((candidate) => existsSync(candidate));
  assert.ok(executable && path.isAbsolute(executable), "DOCKER_BIN must identify an absolute Docker executable");
  return { image, migrationImage, executable: realpathSync(executable) };
}

function context() {
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  const prefix = `tixgo-image-${id}`;
  const artifactRoot = path.resolve(root, process.env.IMAGE_EVIDENCE_DIR || "artifacts/image");
  const directory = path.join(artifactRoot, `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${id}`);
  mkdirSync(directory, { recursive: true });
  return {
    id, directory, artifactRoot, owner: `tixgo.image.verifier=${id}`, network: `${prefix}-net`,
    names: { database: `${prefix}-db`, redis: `${prefix}-redis`, migration: `${prefix}-migration`, api: `${prefix}-api`, worker: `${prefix}-worker` },
    dbPassword: randomBytes(24).toString("hex"), jwtSecret: randomBytes(32).toString("hex"),
    userPassword: randomBytes(20).toString("hex"), cancellation: new AbortController(),
    summary: { version: 1, status: "running", startedAt: new Date().toISOString(), checks: [] },
  };
}

function redact(state, value) {
  let safe = String(value);
  for (const secret of [state.dbPassword, state.jwtSecret, state.userPassword]) safe = safe.replaceAll(secret, "[redacted]");
  return safe.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]");
}

function save(state) {
  const text = `${JSON.stringify(state.summary, null, 2)}\n`;
  writeFileSync(path.join(state.directory, "summary.json"), text);
  writeFileSync(path.join(state.artifactRoot, "summary.json"), text);
}

function record(state, name, evidence = {}) {
  state.summary.checks.push({ name, status: "passed", ...evidence });
  save(state);
  console.log(`Image verification: ${name} passed`);
}

async function docker(state, args, options = {}) {
  try {
    const result = await execute(state.config.executable, args, {
      timeout: options.timeout || 30000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...options.env },
      signal: options.cleanup ? undefined : state.cancellation.signal,
    });
    if (options.captureStderr) return `${result.stdout}${result.stderr}`.trim();
    return result.stdout.trim();
  } catch (error) {
    throw new Error(redact(state, `Docker ${args[0]} failed: ${error.stderr || error.stdout || error.message}`));
  }
}

async function until(check, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`${description} did not complete within ${timeout} ms`);
}

async function startContainer(state, name, image, options = [], command = [], env = {}) {
  const args = ["run", "--detach", "--name", name, "--label", state.owner, "--network", state.network, ...options];
  for (const key of Object.keys(env)) args.push("--env", key);
  const id = await docker(state, [...args, image, ...command], { env, timeout: 120000 });
  assert.match(id, /^[a-f0-9]{64}$/);
  return id;
}

async function hostPort(state, name, port) {
  const published = await docker(state, ["port", name, `${port}/tcp`]);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(published);
  assert.ok(match, "Fixture ports must be published only on loopback");
  return Number(match[1]);
}

async function identifyImage(state, reference) {
  const observed = JSON.parse(await docker(state, ["image", "inspect", reference, "--format", "{{json .}}"]));
  const revision = observed.Config.Labels?.["org.opencontainers.image.revision"];
  assert.match(observed.Id, /^sha256:[a-f0-9]{64}$/);
  assert.ok(revision && revision !== "unknown", "Build images with an OCI source revision label");
  assert.ok(observed.Config.User && !["0", "root", "0:0"].includes(observed.Config.User), "Both image targets must declare a non-root user");
  return { reference, id: observed.Id, revision, user: observed.Config.User, os: observed.Os, architecture: observed.Architecture };
}

async function identifyImages(state) {
  state.images = {
    runtime: await identifyImage(state, state.config.image),
    migration: await identifyImage(state, state.config.migrationImage),
  };
  assert.equal(state.images.runtime.revision, state.images.migration.revision);
  record(state, "immutable image identities", state.images);
}

async function provision(state) {
  await docker(state, ["network", "create", "--label", state.owner, state.network]);
  await startContainer(state, state.names.database, "postgres:15-alpine", ["--publish", "127.0.0.1::5432"], [], {
    POSTGRES_USER: "postgres", POSTGRES_PASSWORD: state.dbPassword, POSTGRES_DB: "tixgo_image_test",
  });
  await startContainer(state, state.names.redis, "redis:7-alpine");
  await until(async () => {
    try {
      await docker(state, ["exec", state.names.database, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "tixgo_image_test"]);
      return true;
    } catch { return false; }
  }, "Isolated PostgreSQL readiness");
  await until(async () => {
    try { return await docker(state, ["exec", state.names.redis, "redis-cli", "ping"]) === "PONG"; }
    catch { return false; }
  }, "Isolated Redis readiness");
  const port = await hostPort(state, state.names.database, 5432);
  state.db = new Pool({ host: "127.0.0.1", port, user: "postgres", password: state.dbPassword, database: "tixgo_image_test", max: 3, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
  state.runtimeEnv = {
    DATABASE_URL: `postgresql://postgres:${state.dbPassword}@${state.names.database}:5432/tixgo_image_test`,
    REDIS_URL: `redis://${state.names.redis}:6379`, JWT_SECRET: state.jwtSecret,
    NODE_ENV: "production", RESERVATION_TTL_SECONDS: "60", RESERVATION_POLL_MS: "50",
  };
  record(state, "isolated test services", { database: "tixgo_image_test", ports: "ephemeral loopback", network: state.network });
}

async function migrate(state) {
  const args = ["run", "--rm", "--name", state.names.migration, "--label", state.owner, "--network", state.network, "--env", "DATABASE_URL", state.images.migration.id];
  const output = await docker(state, args, { env: { DATABASE_URL: state.runtimeEnv.DATABASE_URL }, timeout: 120000, captureStderr: true });
  writeFileSync(path.join(state.directory, "migration.log"), `${redact(state, output)}\n`);
  const { rows } = await state.db.query("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name");
  assert.ok(rows.length > 0, "The migration target must apply the real migration chain");
  record(state, "migration target", { migrations: rows.map((row) => row.migration_name) });
}

function runtimeOptions() {
  return ["--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
}

async function startApi(state) {
  await startContainer(state, state.names.api, state.images.runtime.id, [...runtimeOptions(), "--publish", "127.0.0.1::3000"], [], state.runtimeEnv);
  state.url = `http://127.0.0.1:${await hostPort(state, state.names.api, 3000)}`;
  await until(async () => {
    try { return (await fetch(`${state.url}/health`, { signal: AbortSignal.timeout(1000) })).status === 200; }
    catch { return false; }
  }, "Production API health");
  await until(async () => {
    const health = JSON.parse(await docker(state, ["inspect", state.names.api, "--format", "{{json .State.Health}}"]));
    return health?.Status === "healthy";
  }, "Docker API HEALTHCHECK");
  const response = await fetch(`${state.url}/health`, { signal: AbortSignal.timeout(5000) });
  assert.deepEqual(await response.json(), { status: "Ok" });
  assert.equal(response.headers.get("x-powered-by"), null);
  for (const route of ["/", "/app.js", "/styles.css"]) {
    assert.equal((await fetch(`${state.url}${route}`, { signal: AbortSignal.timeout(5000) })).status, 404);
  }
  record(state, "API health and local UI exclusion", { dockerHealth: "healthy" });
}

async function runtimeShape(state, name, entry) {
  const probe = `const fs=require('node:fs');
const absent=['src','tests','public','docs','.codex','.vscode','.env','.env.example','prisma','prisma.config.ts','tsconfig.json','node_modules/typescript','node_modules/ts-node-dev','node_modules/mocha','node_modules/prisma/build/index.js'];
const managers=['/usr/local/bin/npm','/usr/local/bin/npx','/usr/local/bin/yarn','/usr/local/bin/yarnpkg','/usr/local/bin/corepack'];
console.log(JSON.stringify({uid:process.getuid(),pid1:fs.readFileSync('/proc/1/cmdline','utf8').split(String.fromCharCode(0)).filter(Boolean),unexpected:absent.filter(p=>fs.existsSync('/app/'+p)),packageManagers:managers.filter(p=>fs.existsSync(p)),generatedClient:fs.existsSync('/app/node_modules/.prisma/client/default.js')}));`;
  const observed = JSON.parse(await docker(state, ["exec", name, "node", "-e", probe]));
  assert.notEqual(observed.uid, 0, "Runtime must execute as a non-root UID");
  assert.equal(path.posix.basename(observed.pid1[0]), "node");
  assert.equal(observed.pid1[1], entry);
  assert.deepEqual(observed.unexpected, []);
  assert.deepEqual(observed.packageManagers, []);
  assert.equal(observed.generatedClient, true);
  const constraints = JSON.parse(await docker(state, ["inspect", name, "--format", "{{json .HostConfig}}"]));
  assert.equal(constraints.ReadonlyRootfs, true);
  assert.ok(constraints.CapDrop.includes("ALL"));
  assert.ok(constraints.SecurityOpt.includes("no-new-privileges"));
  assert.equal(await docker(state, ["inspect", name, "--format", "{{.Image}}"]), state.images.runtime.id);
  record(state, `${entry} runtime shape`, observed);
}

async function api(state, method, route, expected, body, token, key) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers["Idempotency-Key"] = key;
  const options = { method, headers, signal: AbortSignal.timeout(10000) };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(`${state.url}${route}`, options);
  assert.equal(response.status, expected, `${method} ${route} returned an unexpected status`);
  return { data: await response.json(), replayed: response.headers.get("Idempotent-Replayed") };
}

async function account(state, role) {
  const input = { email: `${randomUUID()}@image.test`, password: state.userPassword };
  const registration = await api(state, "POST", "/auth/register", 201, input);
  const id = registration.data.data.id;
  if (role === "organizer") await state.db.query("UPDATE users SET role='organizer' WHERE id=$1", [id]);
  const login = await api(state, "POST", "/auth/login", 200, input);
  assert.equal(login.data.data.user.role, role);
  return { id, token: login.data.data.accessToken };
}

async function inventory(state, eventId, expectedRemaining) {
  const { rows: [row] } = await state.db.query(`SELECT e.total_tickets::int AS total, e.remain_tickets::int AS remaining,
    (SELECT count(*)::int FROM reservations r WHERE r.event_id=e.id AND r.status='HELD') AS held,
    (SELECT count(*)::int FROM bookings b WHERE b.event_id=e.id AND b.status='CONFIRMED') AS booked,
    (SELECT count(DISTINCT seat_id)::int FROM bookings b WHERE b.event_id=e.id AND b.status='CONFIRMED') AS distinct_seats
    FROM events e WHERE e.id=$1`, [eventId]);
  assert.equal(row.remaining, expectedRemaining);
  assert.equal(row.remaining + row.held + row.booked, row.total);
  assert.equal(row.booked, row.distinct_seats);
  assert.ok(row.remaining >= 0 && row.remaining <= row.total);
  return row;
}

async function cacheValue(state, reservationId) {
  return docker(state, ["exec", state.names.redis, "redis-cli", "--raw", "GET", `reservation:${reservationId}`]);
}

async function purchase(state) {
  const buyer = await account(state, "buyer");
  const organizer = await account(state, "organizer");
  const created = await api(state, "POST", "/events", 201, { title: "Production image verification", totalTickets: 2, price: "100.00" }, organizer.token);
  const eventId = created.data.data.id;
  const seats = await api(state, "GET", `/events/${eventId}/seats`, 200);
  assert.equal(seats.data.data.length, 2);
  const input = { eventId, seatId: seats.data.data[0].id, reservationId: randomUUID() };
  await api(state, "POST", "/bookings/hold", 201, input, buyer.token);
  await inventory(state, eventId, 1);
  await until(async () => (await cacheValue(state, input.reservationId)).includes('"HELD"'), "Redis hold cache", 5000);
  const key = randomUUID();
  const confirmed = await api(state, "POST", "/bookings", 201, input, buyer.token, key);
  const replay = await api(state, "POST", "/bookings", 200, input, buyer.token, key);
  assert.equal(replay.replayed, "true");
  assert.equal(replay.data.data.id, confirmed.data.data.id);
  await inventory(state, eventId, 1);
  await until(async () => !(await cacheValue(state, input.reservationId)), "Confirmed reservation cache removal", 5000);
  const cancelPath = `/bookings/${confirmed.data.data.id}/cancel`;
  assert.equal((await api(state, "POST", cancelPath, 200, {}, buyer.token)).data.data.status, "CANCELLED");
  await api(state, "POST", cancelPath, 200, {}, buyer.token);
  const snapshot = await inventory(state, eventId, 2);
  record(state, "bcrypt auth, hold, confirm, replay, repeated cancellation and Redis cache", { inventory: snapshot });
  return { buyer, input: { ...input, reservationId: randomUUID() } };
}

async function expiry(state, fixture) {
  await api(state, "POST", "/bookings/hold", 201, fixture.input, fixture.buyer.token);
  await inventory(state, fixture.input.eventId, 1);
  await state.db.query("UPDATE reservations SET created_at=clock_timestamp()-interval '2 minutes', expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [fixture.input.reservationId]);
  await startContainer(state, state.names.worker, state.images.runtime.id, [...runtimeOptions(), "--no-healthcheck"], ["node", "dist/workers/reservation-expiry.worker.js"], state.runtimeEnv);
  await until(async () => {
    const { rows: [row] } = await state.db.query("SELECT status FROM reservations WHERE id=$1", [fixture.input.reservationId]);
    return row.status === "EXPIRED";
  }, "Production worker expiry");
  await runtimeShape(state, state.names.worker, "dist/workers/reservation-expiry.worker.js");
  await inventory(state, fixture.input.eventId, 2);
  await until(async () => !(await cacheValue(state, fixture.input.reservationId)), "Expired reservation cache removal", 5000);
  await pause(250);
  const snapshot = await inventory(state, fixture.input.eventId, 2);
  record(state, "worker recovery of an expired DB deadline exactly once", { inventory: snapshot });
}

async function stop(state, name) {
  const started = Date.now();
  await docker(state, ["kill", "--signal", "SIGTERM", name]);
  await until(async () => !JSON.parse(await docker(state, ["inspect", name, "--format", "{{json .State.Running}}"])), "Graceful SIGTERM shutdown", 20000);
  const observed = JSON.parse(await docker(state, ["inspect", name, "--format", "{{json .State}}"]));
  assert.equal(observed.ExitCode, 0, "SIGTERM must close the process normally");
  assert.equal(observed.OOMKilled, false);
  record(state, `${name.endsWith("-api") ? "API" : "worker"} SIGTERM shutdown`, { exitCode: observed.ExitCode, elapsedMs: Date.now() - started, oomKilled: observed.OOMKilled });
}

async function diagnostics(state) {
  for (const [kind, name] of Object.entries(state.names)) {
    try {
      const output = await docker(state, ["logs", name], { cleanup: true, captureStderr: true });
      writeFileSync(path.join(state.directory, `${kind}.log`), `${redact(state, output)}\n`);
    } catch { /* A failed or --rm migration container may no longer exist. */ }
  }
}

async function removeOwned(state, kind, name) {
  let owner;
  const format = kind === "container" ? '{{index .Config.Labels "tixgo.image.verifier"}}' : '{{index .Labels "tixgo.image.verifier"}}';
  try { owner = await docker(state, [kind, "inspect", name, "--format", format], { cleanup: true }); }
  catch (error) {
    if (/No such|not found/i.test(error.message)) return;
    throw error;
  }
  assert.equal(owner, state.id, "Refusing to remove a resource owned by another process");
  if (kind === "container") await docker(state, ["rm", "--force", "--volumes", name], { cleanup: true });
  else await docker(state, ["network", "rm", name], { cleanup: true });
}

async function cleanup(state) {
  const errors = [];
  if (state.db) await state.db.end().catch((error) => errors.push(redact(state, error.message)));
  for (const name of Object.values(state.names).reverse()) {
    try { await removeOwned(state, "container", name); } catch (error) { errors.push(error.message); }
  }
  try { await removeOwned(state, "network", state.network); } catch (error) { errors.push(error.message); }
  state.summary.cleanup = { status: errors.length ? "failed" : "passed", errors };
  if (errors.length) process.exitCode = 1;
}

async function main() {
  const state = context();
  const interrupt = (signal) => { state.signal = signal; state.cancellation.abort(); };
  const sigint = () => interrupt("SIGINT");
  const sigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);
  try {
    state.config = configuration();
    state.summary.images = { runtime: state.config.image, migration: state.config.migrationImage };
    await identifyImages(state);
    await provision(state);
    await migrate(state);
    await startApi(state);
    await runtimeShape(state, state.names.api, "dist/index.js");
    const fixture = await purchase(state);
    await expiry(state, fixture);
    await stop(state, state.names.worker);
    await stop(state, state.names.api);
    state.summary.status = "passed";
  } catch (error) {
    state.summary.status = "failed";
    state.summary.error = redact(state, error.message);
    process.exitCode = 1;
    console.error(`Image verification failed: ${state.summary.error}`);
  } finally {
    if (state.config) {
      await diagnostics(state);
      await cleanup(state);
    }
    if (state.signal) {
      state.summary.status = "cancelled";
      process.exitCode = state.signal === "SIGINT" ? 130 : 143;
    }
    if (state.summary.cleanup?.status === "failed") state.summary.status = "failed";
    state.summary.finishedAt = new Date().toISOString();
    save(state);
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
  }
  console.log(`Image verification: ${state.summary.status}; ${path.join(state.directory, "summary.json")}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
