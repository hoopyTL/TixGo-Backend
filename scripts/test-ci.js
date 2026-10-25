const { spawn, execFileSync } = require("node:child_process");
const { createWriteStream, mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");

const root = path.resolve(__dirname, "..");
const gates = [
  ["generate", process.execPath, ["node_modules/prisma/build/index.js", "generate"]],
  ["lint", "npm", ["run", "lint"]],
  ["typecheck", "npm", ["run", "typecheck"]],
  ["smoke", "npm", ["test"]],
  ["integration", "npm", ["run", "test:integration"]],
  ["reservation", "npm", ["run", "test:reservation"]],
  ["sql", "npm", ["run", "test:sql"]],
  ["postman", "npm", ["run", "test:postman"]],
];

function sanitize(value) {
  return String(value)
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, "$1[redacted]@")
    .replace(/(rediss?:\/\/)[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]");
}

function configuration() {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required; the development DATABASE_URL is never used.");
  let postgres;
  let redis;
  try { postgres = new URL(process.env.TEST_DATABASE_URL); }
  catch { throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL."); }
  if (!["postgres:", "postgresql:"].includes(postgres.protocol) || !/_test$/.test(decodeURIComponent(postgres.pathname))) {
    throw new Error("TEST_DATABASE_URL must point to a PostgreSQL database ending in _test.");
  }
  if (!process.env.TEST_REDIS_URL) throw new Error("TEST_REDIS_URL is required; the development REDIS_URL is never used.");
  try { redis = new URL(process.env.TEST_REDIS_URL); }
  catch { throw new Error("TEST_REDIS_URL must be a valid Redis URL."); }
  if (redis.protocol !== "redis:" || !["localhost", "127.0.0.1"].includes(redis.hostname) || redis.port !== "56379") {
    throw new Error("TEST_REDIS_URL must use the isolated loopback Compose test-redis endpoint on port 56379.");
  }
  const timeout = Number(process.env.CI_STAGE_TIMEOUT_MS || 600000);
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 1800000) {
    throw new Error("CI_STAGE_TIMEOUT_MS must be an integer from 1000 to 1800000.");
  }
  return { postgres, redis, timeout };
}

function terminate(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") console.error(`Unable to stop test process: ${sanitize(error.message)}`);
  }
}

async function runGate(gate, environment, directory, timeout, interruption) {
  const [name, executable, args] = gate;
  const filename = `${String(gates.indexOf(gate) + 1).padStart(2, "0")}-${name}.log`;
  const result = { name, command: [executable, ...args], status: "running", startedAt: new Date().toISOString(), log: filename };
  const output = createWriteStream(path.join(directory, filename), { flags: "wx" });
  let outputError;
  output.on("error", (error) => { outputError = error; interruption.stop?.(); });
  const tail = [];
  const record = (line) => {
    const safe = sanitize(line);
    output.write(`${safe}\n`);
    tail.push(safe);
    if (tail.length > 40) tail.shift();
  };
  console.log(`CI: starting ${name}`);
  const child = spawn(executable, args, { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  interruption.child = child;
  let timedOut = false;
  let force;
  const stop = () => {
    terminate(child, "SIGTERM");
    if (!force) force = setTimeout(() => terminate(child, "SIGKILL"), 5000);
  };
  interruption.stop = stop;
  if (interruption.signal) stop();
  const timer = setTimeout(() => {
    timedOut = true;
    record(`Stage exceeded ${timeout} ms; terminating its process group.`);
    stop();
  }, timeout);
  createInterface({ input: child.stdout }).on("line", record);
  createInterface({ input: child.stderr }).on("line", record);
  child.once("error", (error) => record(error.message));
  const closed = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  clearTimeout(timer);
  // The direct child may exit before a descendant that ignored SIGTERM and closed its pipes.
  // Every stage owns a separate process group, so only that stage's descendants are removed.
  if (process.platform !== "win32") terminate(child, "SIGKILL");
  clearTimeout(force);
  interruption.child = undefined;
  interruption.stop = undefined;
  if (!outputError) await new Promise((resolve, reject) => { output.once("error", reject); output.end(resolve); });
  if (outputError) throw outputError;
  result.finishedAt = new Date().toISOString();
  result.exitCode = timedOut ? 124 : closed.code ?? (closed.signal === "SIGINT" ? 130 : closed.signal === "SIGTERM" ? 143 : 1);
  result.signal = closed.signal;
  result.timedOut = timedOut;
  result.status = interruption.signal ? "cancelled" : result.exitCode === 0 ? "passed" : "failed";
  console.log(`CI: ${name} ${result.status} (exit ${result.exitCode})`);
  if (result.status !== "passed") console.error(tail.join("\n"));
  return result;
}

async function main() {
  const artifactRoot = path.resolve(root, process.env.CI_ARTIFACT_DIR || "artifacts/ci");
  const relative = path.relative(artifactRoot, root);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("CI_ARTIFACT_DIR must be a dedicated output directory, not the repository or its parent.");
  }
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const directory = path.join(artifactRoot, runId);
  mkdirSync(directory, { recursive: true });
  let sha;
  try { sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { sha = null; }
  const summary = { version: 1, runId, node: process.version, sha, status: "running", startedAt: new Date().toISOString(), artifactDirectory: directory, steps: [] };
  const save = () => {
    const json = `${JSON.stringify(summary, null, 2)}\n`;
    writeFileSync(path.join(directory, "summary.json"), json);
    writeFileSync(path.join(artifactRoot, "summary.json"), json);
  };
  const interruption = {};
  const interrupt = (signal) => { interruption.signal = signal; interruption.stop?.(); };
  const sigint = () => interrupt("SIGINT");
  const sigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);
  save();
  try {
    const config = configuration();
    summary.targets = { postgres: { hostname: config.postgres.hostname, port: config.postgres.port || "5432", database: decodeURIComponent(config.postgres.pathname.slice(1)) }, redis: { hostname: config.redis.hostname, port: config.redis.port } };
    const environment = { ...process.env, DATABASE_URL: config.postgres.toString(), REDIS_URL: config.redis.toString(), NODE_ENV: "test", JWT_SECRET: "ci-only-test-secret-not-for-production", BOOKING_EVIDENCE_DIR: path.join(directory, "evidence"), SQL_EVIDENCE_DIR: path.join(directory, "sql") };
    for (const gate of gates) {
      if (interruption.signal) break;
      summary.currentStep = gate[0];
      save();
      const result = await runGate(gate, environment, directory, config.timeout, interruption);
      summary.steps.push(result);
      save();
      if (result.status !== "passed") {
        summary.failedStep = result.name;
        process.exitCode = result.exitCode || 1;
        break;
      }
    }
    summary.status = interruption.signal ? "cancelled" : summary.steps.length === gates.length && summary.steps.every((step) => step.status === "passed") ? "passed" : "failed";
    if (interruption.signal) process.exitCode = interruption.signal === "SIGINT" ? 130 : 143;
    else if (summary.status !== "passed") process.exitCode ||= 1;
  } catch (error) {
    summary.status = "failed";
    summary.failedStep ||= summary.currentStep || "configuration";
    summary.error = sanitize(error.message);
    process.exitCode = 1;
    console.error(`CI: ${summary.error}`);
  } finally {
    summary.finishedAt = new Date().toISOString();
    delete summary.currentStep;
    save();
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
  }
  console.log(`CI: ${summary.status}; summary ${path.join(directory, "summary.json")}`);
}

main().catch((error) => { console.error(`CI: ${sanitize(error.message)}`); process.exitCode = 1; });
