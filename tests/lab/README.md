# Booking concurrency evidence

Run against a disposable PostgreSQL database whose name ends in `_test`:

```sh
export TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/tixgo_test
node tests/booking-lab.js
npm run build
node tests/booking-load.js
```

The lab creates an isolated schema, starts a loopback-only HTTP server, runs real
k6 with 100 virtual clients and one request per client, captures the database,
and drops only its own schema. It compares stale read/absolute-write with Event
row locking. Both variants have a deliberately documented 80 ms read/write gap,
a pool of 20 connections, and a one-ticket event. The stale write can oversell
even while the database constraint still keeps the ticket counter nonnegative.
This teaching implementation cannot be enabled through the application API.

The load runner migrates a separate schema, provisions fixture users, starts two
actual API processes with separate connection pools, and runs one- and two-API
variants. Workload A sends exactly 5,000 confirm requests for 100 held seats.
Workload B sends 5,000 hold requests and 100 winning confirm requests: 5,100 HTTP
requests, not 5,000. Auth/seed/health traffic is outside those headline counts.
All HTTP requests carry distinct operation identities except explicit replay
tests elsewhere. Independent fixture events use separate key namespaces.

Use `LOAD_INSTANCES=2` to run only the two-process workload. Set `K6_BIN` if k6 is
not on PATH. The lab automatically captures `before-after.png` when a supported
Chromium browser exists; set `CHROME_BIN` to its absolute binary path otherwise.
To capture an existing SVG manually, run:

```sh
node tests/lab/render-proof.js docs/reports/booking-c/<lab-run-id>
```

Evidence is saved under ignored local `docs/reports/booking-c/<run-id>/`: raw k6
metrics, summaries, status totals, transaction timestamps, database snapshots,
and manifests. Temporary load fixtures contain short-lived test JWTs, are mode
0600, and are deleted after each scenario. No token is included in public logs.
Review the database assertions alongside HTTP metrics; valid business conflicts
are different from system errors or unknown network outcomes.

The screenshot is a browser capture of a report generated directly from the
captured PostgreSQL results. It documents the controlled lab, not a claim that
the unsafe algorithm was exposed in production. A green load run establishes
the tested invariants for that workload; it is not a throughput or HA guarantee.
