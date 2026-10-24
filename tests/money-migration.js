const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const migrationName = "20261025100000_exact_event_price_catalog_index";
const migrationsDir = path.join(__dirname, "../prisma/migrations");
const migration = readFileSync(path.join(migrationsDir, migrationName, "migration.sql"), "utf8");

async function rows(client, table) {
  return (await client.query(`SELECT * FROM "${table}" ORDER BY ${table === "idempotency_keys" ? "key" : "id"}`)).rows;
}

async function scenario(pool, invalidPrice) {
  const client = await pool.connect();
  const schema = `MoneyMigration_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await client.query("SELECT set_config('search_path',$1,false)", [`"${schema}"`]);
    for (const entry of readdirSync(migrationsDir, { withFileTypes: true })
      .filter((item) => item.isDirectory() && item.name < migrationName).sort((a, b) => a.name.localeCompare(b.name))) {
      await client.query(readFileSync(path.join(migrationsDir, entry.name, "migration.sql"), "utf8"));
    }
    const owner = randomUUID();
    const buyer = randomUUID();
    await client.query("INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,'fixture','organizer'),($3,$4,'fixture','buyer')",
      [owner, `${owner}@example.com`, buyer, `${buyer}@example.com`]);
    const prices = invalidPrice === undefined ? ["0.10", "123.45", "9999999999.99"] : [invalidPrice];
    const eventIds = [];
    for (const price of prices) {
      const id = randomUUID();
      eventIds.push(id);
      await client.query("INSERT INTO events(id,title,total_tickets,remain_tickets,price,organizer_id) VALUES($1,'Historical price fixture',3,2,$2::double precision,$3)", [id, price, owner]);
    }
    const bookingId = randomUUID();
    const { rows: [booking] } = await client.query("INSERT INTO bookings(id,user_id,event_id) VALUES($1,$2,$3) RETURNING *", [bookingId, buyer, eventIds[0]]);
    const cached = JSON.stringify({ id: booking.id, userId: booking.user_id, eventId: booking.event_id, status: booking.status, createdAt: booking.created_at.toISOString() });
    await client.query("INSERT INTO idempotency_keys(key,user_id,request_hash,status,response_status,response_body,updated_at) VALUES($1,$2,'fixture','COMPLETED',201,$3,NOW())", [randomUUID(), buyer, cached]);
    const before = {};
    for (const table of ["users", "events", "bookings", "idempotency_keys"]) before[table] = await rows(client, table);

    if (invalidPrice === undefined) {
      await client.query(migration);
      const afterEvents = await rows(client, "events");
      for (const event of afterEvents) {
        const old = before.events.find((entry) => entry.id === event.id);
        const expectedPrice = prices[eventIds.indexOf(event.id)];
        assert.deepEqual(event, { ...old, price: expectedPrice });
      }
      const { rows: [type] } = await client.query("SELECT data_type,numeric_precision,numeric_scale FROM information_schema.columns WHERE table_schema=$1 AND table_name='events' AND column_name='price'", [schema]);
      assert.deepEqual(type, { data_type: "numeric", numeric_precision: 12, numeric_scale: 2 });
      const { rows: [constraint] } = await client.query("SELECT convalidated FROM pg_constraint WHERE conrelid='events'::regclass AND conname='events_price_nonnegative'");
      assert.equal(constraint.convalidated, true);
      const { rows: indexes } = await client.query("SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname='events_created_at_id_idx'", [schema]);
      assert.equal(indexes.length, 1);
    } else {
      await assert.rejects(() => client.query(migration), { code: "23514" });
      await client.query("ROLLBACK");
      assert.deepEqual(await rows(client, "events"), before.events);
      const { rows: [type] } = await client.query("SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='events' AND column_name='price'", [schema]);
      assert.equal(type.data_type, "double precision");
      const { rows: indexes } = await client.query("SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname='events_created_at_id_idx'", [schema]);
      assert.equal(indexes.length, 0);
    }
    for (const table of ["users", "bookings", "idempotency_keys"]) assert.deepEqual(await rows(client, table), before[table]);
    return { case: invalidPrice === undefined ? "exact historical 0.10/123.45/max value" : `reject ${invalidPrice}`, status: "PASS", usersBookingsCachedResponsesPreserved: true };
  } finally {
    try {
      await client.query("ROLLBACK");
      if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally { client.release(true); }
  }
}

async function main() {
  assert.ok(process.env.TEST_DATABASE_URL, "Set TEST_DATABASE_URL to a separate PostgreSQL database ending in _test.");
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.match(decodeURIComponent(url.pathname), /_test$/, "Refusing a non-test database.");
  const pool = new Pool({ connectionString: url.toString() });
  try {
    const results = [await scenario(pool)];
    for (const price of ["-0.01", "0.001", "0.30000000000000004", "NaN", "Infinity", "-Infinity", "10000000000"]) results.push(await scenario(pool, price));
    if (process.env.SQL_EVIDENCE_DIR) {
      mkdirSync(process.env.SQL_EVIDENCE_DIR, { recursive: true });
      writeFileSync(path.join(process.env.SQL_EVIDENCE_DIR, "money-migration-results.json"), `${JSON.stringify({ migrationName, results }, null, 2)}\n`);
    }
    console.log(`${results.length} money migration scenarios passed; all fixture schemas removed.`);
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
