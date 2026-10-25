const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const supertest = require("supertest");
const { testDatabaseUrl, migrationFiles, migrate, migrationsDirectory, recordEvidence, standaloneApi, stopChild } = require("./helpers/reservation-fixture");

const execFileAsync = promisify(execFile);
const migrationName = "20261025120000_reservation_lifecycle";
const migration = () => readFileSync(path.join(migrationsDirectory, migrationName, "migration.sql"), "utf8");

async function legacyFixture(run) {
  const url = testDatabaseUrl();
  const pool = new Pool({ connectionString: url.toString() });
  const client = await pool.connect();
  const schema = `Migration_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query("SELECT set_config('search_path',$1,false)", [`"${schema}"`]);
    await migrate(client, migrationFiles().filter((name) => name < migrationName));
    const ids = { organizer: randomUUID(), buyer: randomUUID(), other: randomUUID(), event: randomUUID(), confirmed: randomUUID(), cancelled: randomUUID(), key: randomUUID() };
    await client.query("INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,'fixture','organizer'),($3,$4,'fixture','buyer'),($5,$6,'fixture','buyer')", [ids.organizer, `${ids.organizer}@example.com`, ids.buyer, `${ids.buyer}@example.com`, ids.other, `${ids.other}@example.com`]);
    await client.query("INSERT INTO events(id,title,total_tickets,remain_tickets,price,organizer_id) VALUES($1,'Legacy booking migration',3,2,'123.45',$2)", [ids.event, ids.organizer]);
    await client.query("INSERT INTO bookings(id,user_id,event_id,status) VALUES($1,$2,$3,'CONFIRMED'),($4,$2,$3,'CANCELLED')", [ids.confirmed, ids.buyer, ids.event, ids.cancelled]);
    const { rows: [booking] } = await client.query("SELECT * FROM bookings WHERE id=$1", [ids.confirmed]);
    const response = JSON.stringify({ id: booking.id, userId: booking.user_id, eventId: booking.event_id, status: booking.status, createdAt: booking.created_at.toISOString() });
    const hash = createHash("sha256").update(JSON.stringify({ userId: ids.buyer, body: { eventId: ids.event } })).digest("hex");
    await client.query("INSERT INTO idempotency_keys(key,user_id,request_hash,status,response_status,response_body,updated_at) VALUES($1,$2,$3,'COMPLETED',201,$4,NOW())", [ids.key, ids.buyer, hash, response]);
    await run({ client, pool, schema, ids, url });
  } finally {
    await client.query("ROLLBACK");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  }
}

async function snapshot(client, schema) {
  const state = {};
  for (const table of ["users", "events", "seats", "reservations", "bookings", "idempotency_keys"]) {
    state[table] = (await client.query(`SELECT to_jsonb(row) AS value FROM "${schema}".${table} row ORDER BY to_jsonb(row)::text`)).rows.map((row) => row.value);
  }
  return state;
}

describe("Reservation migration and recovery", () => {
  it("uses backfilled seat/reservation UUIDs through the actual API and replays historical purchases", async function () {
    this.timeout(20000);
    await legacyFixture(async ({ client, ids, schema, url }) => {
      const cached = (await client.query("SELECT response_body FROM idempotency_keys WHERE key=$1", [ids.key])).rows[0].response_body;
      await client.query(migration());
      const connection = new URL(url.toString());
      connection.searchParams.set("schema", schema);
      connection.searchParams.set("options", `-c search_path="${schema}" -c statement_timeout=15000`);
      const secret = "migration-api-test-secret";
      const token = jwt.sign({ userId: ids.buyer, role: "buyer" }, secret, { expiresIn: "1h" });
      const api = await standaloneApi(connection.toString(), { JWT_SECRET: secret });
      const request = () => supertest(api.address);
      const auth = (call) => call.set("Authorization", `Bearer ${token}`);
      try {
        const seats = await request().get(`/events/${ids.event}/seats`);
        assert.equal(seats.status, 200);
        assert.equal(seats.body.data.length, 3);
        const legacyBooking = (await client.query("SELECT * FROM bookings WHERE id=$1", [ids.confirmed])).rows[0];
        const oldHold = await auth(request().get(`/bookings/holds/${legacyBooking.reservation_id}`));
        assert.equal(oldHold.status, 200, JSON.stringify(oldHold.body));
        assert.equal(oldHold.body.data.status, "CONFIRMED");
        const seat = seats.body.data.find((entry) => entry.status === "AVAILABLE");
        assert.ok(seat);
        const input = { eventId: ids.event, seatId: seat.id, reservationId: randomUUID() };
        const held = await auth(request().post("/bookings/hold")).send(input);
        assert.equal(held.status, 201, JSON.stringify(held.body));
        const confirmed = await auth(request().post("/bookings")).set("Idempotency-Key", randomUUID()).send(input);
        assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
        const replay = await auth(request().post("/bookings")).set("Idempotency-Key", ids.key).send({ eventId: ids.event });
        assert.equal(replay.status, 200);
        assert.equal(replay.headers["idempotent-replayed"], "true");
        assert.deepEqual(replay.body.data, JSON.parse(cached));
        const cancel = await auth(request().post(`/bookings/${ids.confirmed}/cancel`)).send({});
        assert.equal(cancel.status, 200);
        const freed = await auth(request().post("/bookings/hold")).send({ eventId: ids.event, seatId: legacyBooking.seat_id, reservationId: randomUUID() });
        assert.equal(freed.status, 201, JSON.stringify(freed.body));
        const afterCancel = await auth(request().post("/bookings")).set("Idempotency-Key", ids.key).send({ eventId: ids.event });
        assert.deepEqual(afterCancel.body.data, JSON.parse(cached));
        const current = await auth(request().get(`/bookings/${ids.confirmed}`));
        assert.equal(current.body.data.status, "CANCELLED");
        const { rows: [state] } = await client.query(`SELECT e.total_tickets::int total,e.remain_tickets::int remaining,
          (SELECT count(*)::int FROM reservations WHERE event_id=e.id AND status='HELD') held,
          (SELECT count(*)::int FROM bookings WHERE event_id=e.id AND status='CONFIRMED') booked
          FROM events e WHERE id=$1`, [ids.event]);
        assert.deepEqual(state, { total: 3, remaining: 1, held: 1, booked: 1 });
        recordEvidence("migration-api", { schema, apiPid: api.child.pid, migratedBookingId: ids.confirmed,
          migratedSeatId: legacyBooking.seat_id, migratedReservationId: legacyBooking.reservation_id,
          statuses: { syntheticReservationRead: oldHold.status, backfilledSeatHold: held.status, confirm: confirmed.status,
            legacyReplay: replay.status, cancelLegacy: cancel.status, reholdLegacySeat: freed.status }, state, cachedSnapshotPreserved: true });
      } finally { await stopChild(api.child); }
    });
  });

  it("preserves confirmed/cancelled identity, stock and legacy cached responses", async () => {
    await legacyFixture(async ({ client, ids }) => {
      const beforeBookings = (await client.query("SELECT * FROM bookings ORDER BY id")).rows;
      const beforeKey = (await client.query("SELECT * FROM idempotency_keys WHERE key=$1", [ids.key])).rows[0];
      await client.query(migration());
      const bookings = (await client.query("SELECT * FROM bookings ORDER BY id")).rows;
      for (const previous of beforeBookings) {
        const next = bookings.find((row) => row.id === previous.id);
        for (const [key, value] of Object.entries(previous)) assert.deepEqual(next[key], value);
      }
      const confirmed = bookings.find((row) => row.id === ids.confirmed);
      const cancelled = bookings.find((row) => row.id === ids.cancelled);
      assert.ok(confirmed.seat_id && confirmed.reservation_id);
      assert.equal(cancelled.seat_id, null);
      assert.equal(cancelled.reservation_id, null);
      const { rows: [reservation] } = await client.query("SELECT * FROM reservations WHERE id=$1", [confirmed.reservation_id]);
      assert.equal(reservation.status, "CONFIRMED");
      assert.equal(reservation.user_id, ids.buyer);
      assert.equal(reservation.seat_id, confirmed.seat_id);
      assert.ok(reservation.expires_at > reservation.created_at);
      const { rows: [afterKey] } = await client.query("SELECT * FROM idempotency_keys WHERE key=$1", [ids.key]);
      for (const [key, value] of Object.entries(beforeKey)) assert.deepEqual(afterKey[key], value);
      assert.equal(afterKey.operation, "booking.create.v1");
      assert.equal((await client.query("SELECT count(*)::int AS n FROM seats WHERE event_id=$1", [ids.event])).rows[0].n, 3);
      assert.equal((await client.query("SELECT remain_tickets FROM events WHERE id=$1", [ids.event])).rows[0].remain_tickets, 2);
    });
  });

  for (const corruption of ["inconsistent inventory", "unsupported status"]) {
    it(`rejects ${corruption} atomically instead of repairing or losing history`, async () => {
      await legacyFixture(async ({ client, ids, schema }) => {
        if (corruption === "inconsistent inventory") await client.query("UPDATE events SET remain_tickets=3 WHERE id=$1", [ids.event]);
        else await client.query("UPDATE bookings SET status='UNSUPPORTED' WHERE id=$1", [ids.confirmed]);
        const before = (await client.query("SELECT * FROM bookings ORDER BY id")).rows;
        await assert.rejects(() => client.query(migration()), /Historical booking\/inventory invariant|Unsupported historical booking state/);
        await client.query("ROLLBACK");
        assert.deepEqual((await client.query("SELECT * FROM bookings ORDER BY id")).rows, before);
        assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name='seats'", [schema])).rows[0].n, 0);
      });
    });
  }

  it("enforces seat/event identity, booking ownership and active-seat uniqueness", async () => {
    await legacyFixture(async ({ client, ids }) => {
      await client.query(migration());
      const seats = (await client.query("SELECT * FROM seats WHERE event_id=$1 ORDER BY number", [ids.event])).rows;
      const otherEvent = randomUUID();
      await client.query("INSERT INTO events(id,title,total_tickets,remain_tickets,price,organizer_id) VALUES($1,'Other event',1,1,'1.00',$2)", [otherEvent, ids.organizer]);
      const reservation = async (seatId, eventId = ids.event, status = "HELD") => {
        const id = randomUUID();
        await client.query("INSERT INTO reservations(id,user_id,event_id,seat_id,status,created_at,expires_at,updated_at) VALUES($1,$2,$3,$4,$5,NOW(),NOW()+interval '5 minutes',NOW())", [id, ids.buyer, eventId, seatId, status]);
        return id;
      };
      await assert.rejects(() => reservation(seats[1].id, otherEvent), { code: "23503" });
      await reservation(seats[1].id);
      await assert.rejects(() => reservation(seats[1].id), { code: "23505" });
      const unbooked = await reservation(seats[2].id, ids.event, "CONFIRMED");
      await assert.rejects(() => client.query("INSERT INTO bookings(id,user_id,event_id,seat_id,reservation_id,status) VALUES($1,$2,$3,$4,$5,'CONFIRMED')", [randomUUID(), ids.other, ids.event, seats[2].id, unbooked]), { code: "23503" });
      const duplicate = await reservation(seats[0].id, ids.event, "CONFIRMED");
      await assert.rejects(() => client.query("INSERT INTO bookings(id,user_id,event_id,seat_id,reservation_id,status) VALUES($1,$2,$3,$4,$5,'CONFIRMED')", [randomUUID(), ids.buyer, ids.event, seats[0].id, duplicate]), { code: "23505" });
      await assert.rejects(() => client.query("INSERT INTO bookings(id,user_id,event_id,status) VALUES($1,$2,$3,'CONFIRMED')", [randomUUID(), ids.buyer, ids.event]), { code: "23514" });
    });
  });

  it("backs up the migrated lab schema with pg_dump and restores it to an isolated schema", async function () {
    this.timeout(30000);
    await legacyFixture(async ({ client, schema, url }) => {
      await client.query(migration());
      const before = await snapshot(client, schema);
      const { stdout } = await execFileAsync("docker", ["compose", "--profile", "test", "exec", "-T", "test-db", "pg_dump", "-U", decodeURIComponent(url.username), "--dbname", decodeURIComponent(url.pathname.slice(1)), "--schema", `"${schema}"`, "--no-owner", "--no-privileges", "--inserts", "--column-inserts"], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
      assert.ok(stdout.includes("CREATE TABLE"));
      const restored = `Restore_${randomUUID().replaceAll("-", "")}`;
      const sql = stdout.replaceAll(`"${schema}"`, `"${restored}"`).split("\n").filter((line) => !line.startsWith("\\")).join("\n");
      try {
        await client.query(sql);
        const after = await snapshot(client, restored);
        assert.deepEqual(after, before);
        const { rows } = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname=$1`, [restored]);
        assert.ok(rows.some((row) => row.indexname === "reservations_one_held_seat"));
        assert.ok(rows.some((row) => row.indexname === "bookings_one_confirmed_seat"));
        recordEvidence("migration-restore", {
          migration: migrationName, sourceSchema: schema, restoredSchema: restored,
          backupTool: "PostgreSQL 15 pg_dump --inserts --column-inserts in test-db container",
          backupBytes: Buffer.byteLength(stdout), tables: Object.fromEntries(Object.entries(before).map(([table, values]) => [table, values.length])),
          sourceSha256: createHash("sha256").update(JSON.stringify(before)).digest("hex"),
          restoredSha256: createHash("sha256").update(JSON.stringify(after)).digest("hex"),
          snapshotsIdentical: true, restoredIndexes: rows.map((row) => row.indexname).sort(),
        });
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS "${restored}" CASCADE`);
      }
    });
  });
});
