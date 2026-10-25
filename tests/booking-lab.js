const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { startLab } = require("./lab/booking-server");
const execute = promisify(execFile);

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, "Set TEST_DATABASE_URL to a database ending in _test");
  const parsed = new URL(databaseUrl);
  assert.match(decodeURIComponent(parsed.pathname), /_test$/);
  const runId = `lab-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const destination = path.resolve("docs/reports/booking-c", runId);
  await mkdir(destination, { recursive: true });
  const pool = new Pool({ connectionString: databaseUrl });
  const secret = "isolated-booking-lab-secret";
  const userId = randomUUID();
  const token = jwt.sign({ userId, role: "buyer" }, secret, { expiresIn: "15m" });
  const results = [];
  try {
    for (const mode of ["unsafe", "locked"]) {
      const schema = `Lab_${randomUUID().replaceAll("-", "")}`;
      const client = await pool.connect();
      const eventId = randomUUID();
      let lab;
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}"`);
        await client.query("CREATE TABLE lab_events(id text PRIMARY KEY,total_tickets integer NOT NULL CHECK(total_tickets>0),remain_tickets integer NOT NULL CHECK(remain_tickets>=0 AND remain_tickets<=total_tickets))");
        await client.query("CREATE TABLE lab_bookings(id text PRIMARY KEY,event_id text NOT NULL REFERENCES lab_events(id),user_id text NOT NULL,request_key text NOT NULL,UNIQUE(user_id,request_key))");
        await client.query("INSERT INTO lab_events VALUES($1,1,1)", [eventId]);
        lab = await startLab({ connectionString: databaseUrl, schema, mode, secret });
        const run = await execute(process.env.K6_BIN || "k6", ["run", "--quiet", "--out", `json=${path.join(destination, `${mode}-raw.jsonl`)}`, "tests/k6/booking-race.js"], {
          env: { ...process.env, BASE_URL: lab.url, EVENT_ID: eventId, TOKEN: token, RUN_ID: runId, MODE: mode, SUMMARY_PATH: path.join(destination, `${mode}-summary.json`) },
          maxBuffer: 4 * 1024 * 1024,
          timeout: 45000,
        }).catch((error) => ({ stdout: error.stdout || "", stderr: error.stderr || "", error }));
        await writeFile(path.join(destination, `${mode}-k6.log`), run.stdout + run.stderr);
        await writeFile(path.join(destination, `${mode}-transactions.json`), JSON.stringify(lab.traces, null, 2));
        if (run.error) throw new Error(`k6 ${mode} failed; see ${destination} (${lab.traces[0]?.error || "threshold failure"})`);
        const { rows: [state] } = await client.query("SELECT e.total_tickets,e.remain_tickets,count(b.id)::int AS bookings FROM lab_events e LEFT JOIN lab_bookings b ON b.event_id=e.id GROUP BY e.id");
        const statuses = lab.traces.reduce((counts, trace) => { counts[trace.status] = (counts[trace.status] || 0) + 1; return counts; }, {});
        assert.equal(lab.traces.length, 100);
        assert.equal(statuses[500] || 0, 0);
        assert.equal(state.remain_tickets, 0);
        if (mode === "unsafe") assert.ok(state.bookings > 1, "Oversell was not reproduced; inspect read/write timing");
        else { assert.equal(state.bookings, 1); assert.equal(statuses[201], 1); assert.equal(statuses[409], 99); }
        const overlappingReaders = lab.traces.filter((trace) => trace.readTickets === 1).length;
        if (mode === "unsafe") assert.ok(overlappingReaders > 1);
        const result = { mode, ...state, statuses, overlappingReaders, invariantHolds: state.remain_tickets + state.bookings === state.total_tickets };
        results.push(result);
        await writeFile(path.join(destination, `${mode}-transactions.json`), JSON.stringify(lab.traces, null, 2));
        await writeFile(path.join(destination, `${mode}-database.json`), JSON.stringify(result, null, 2));
        console.log(`${mode}: ${state.bookings} bookings, ${state.remain_tickets} remaining; statuses=${JSON.stringify(statuses)}`);
      } finally {
        if (lab) await lab.close();
        await client.query("RESET search_path");
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        client.release();
      }
    }
    const { stdout: version } = await execute(process.env.K6_BIN || "k6", ["version"]);
    const { stdout: sha } = await execute("git", ["rev-parse", "HEAD"]);
    const { stdout: diff } = await execute("git", ["diff", "--stat"]);
    const { rows: [postgres] } = await pool.query("SELECT version() AS version");
    const manifest = { runId, at: new Date().toISOString(), node: process.version, k6: version.trim(), postgres: postgres.version, os: `${os.platform()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length, memoryBytes: os.totalmem(), sha: sha.trim(), dirtyDiff: diff, workload: { virtualClients: 100, iterationsPerClient: 1, requests: 100, capacity: 1, poolSize: 20, artificialReadWriteDelayMs: 80, isolation: "READ COMMITTED" }, command: "TEST_DATABASE_URL=<test-db> node tests/booking-lab.js", results };
    await writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2));
    const cards = results.map((result, i) => `<g transform="translate(${i * 500 + 30},90)"><rect width="460" height="260" rx="14" fill="${i ? "#063b2a" : "#4c1723"}"/><text x="24" y="45" font-size="26">${i ? "AFTER · Event row lock" : "BEFORE · Lost update"}</text><text x="24" y="95" font-size="38">${result.bookings} bookings / 1 ticket</text><text x="24" y="140" font-size="23">Remaining: ${result.remain_tickets}</text><text x="24" y="180" font-size="23">HTTP 201: ${result.statuses[201]} · 409: ${result.statuses[409] || 0}</text><text x="24" y="220" font-size="23">Invariant: ${result.invariantHolds ? "PASS" : "BROKEN"}</text></g>`).join("");
    await writeFile(path.join(destination, "before-after.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="430" viewBox="0 0 1040 430"><rect width="1040" height="430" fill="#101722"/><g fill="#fff" font-family="Arial,sans-serif"><text x="30" y="48" font-size="28">Booking correctness · actual k6/PostgreSQL results</text>${cards}<text x="30" y="390" font-size="16">100 VUs × 1 POST · pool 20 · artificial 80 ms read/write window · ${runId}</text></g></svg>`);
    manifest.visualEvidence = await require("./lab/render-proof").renderProof(destination);
    await writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(`PASS: oversell reproduced and repaired with identical workload. Evidence: ${destination}`);
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
