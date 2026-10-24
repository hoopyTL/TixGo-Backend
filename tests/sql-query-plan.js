const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const schema = `SQLModel_${randomUUID().replaceAll("-", "")}`;
const indexName = "events_created_at_id_idx";
const migrationsDir = path.join(__dirname, "../prisma/migrations");
const columns = "id, title, description, location, total_tickets, remain_tickets, price, created_at";
const firstPage = `SELECT ${columns} FROM events ORDER BY created_at DESC, id DESC LIMIT 51`;
const nextPage = `SELECT ${columns} FROM events WHERE (created_at, id) < ($1::timestamp, $2::text) ORDER BY created_at DESC, id DESC LIMIT 51`;

function nodes(plan) {
  return [plan, ...(plan.Plans || []).flatMap(nodes)];
}

async function explain(client, query, values = []) {
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, values);
  return rows[0]["QUERY PLAN"][0];
}

function summary(result) {
  return {
    executionMs: result["Execution Time"],
    planningMs: result["Planning Time"],
    returnedRows: result.Plan["Actual Rows"],
    sharedHitBlocks: result.Plan["Shared Hit Blocks"],
    sharedReadBlocks: result.Plan["Shared Read Blocks"],
    nodes: nodes(result.Plan).map((entry) => ({
      type: entry["Node Type"], index: entry["Index Name"],
      rows: entry["Actual Rows"], sort: entry["Sort Method"],
    })),
  };
}

function saveEvidence(name, value) {
  if (!process.env.SQL_EVIDENCE_DIR) return;
  mkdirSync(process.env.SQL_EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(process.env.SQL_EVIDENCE_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const configured = process.env.TEST_DATABASE_URL;
  assert.ok(configured, "Set TEST_DATABASE_URL to a separate PostgreSQL database ending in _test.");
  const url = new URL(configured);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.match(decodeURIComponent(url.pathname), /_test$/, "Refusing a non-test database.");
  const pool = new Pool({ connectionString: url.toString() });
  const client = await pool.connect();
  let created = false;
  try {
    const { rows: [identity] } = await client.query("SELECT current_database() AS database, version() AS version");
    assert.match(identity.database, /_test$/);
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await client.query("SELECT set_config('search_path', $1, false)", [`"${schema}"`]);
    for (const entry of readdirSync(migrationsDir, { withFileTypes: true }).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      await client.query(readFileSync(path.join(migrationsDir, entry.name, "migration.sql"), "utf8"));
    }

    const organizer = randomUUID();
    const buyer = randomUUID();
    await client.query("INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,'fixture','organizer'),($3,$4,'fixture','buyer')",
      [organizer, `${organizer}@example.com`, buyer, `${buyer}@example.com`]);
    await client.query(`INSERT INTO events(id,title,description,location,total_tickets,remain_tickets,price,created_at,organizer_id)
      SELECT '00000000-0000-4000-8000-' || lpad(n::text,12,'0'), 'SQL benchmark ' || n,
        'Seeded catalog fixture', 'Lab', 100, 100, 123.45,
        TIMESTAMP '2026-01-01' + n * INTERVAL '1 millisecond', $1
      FROM generate_series(1,50000) AS source(n)`, [organizer]);
    const ids = [1, 2].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
    for (const id of ids) {
      await client.query("INSERT INTO bookings(id,user_id,event_id) VALUES($1,$2,$3)", [randomUUID(), buyer, id]);
      await client.query("UPDATE events SET remain_tickets=99 WHERE id=$1", [id]);
    }
    const joined = await client.query(`SELECT b.id AS booking_id, b.user_id AS buyer_id, e.id AS event_id,
      e.organizer_id, owner.role AS owner_role, purchaser.role AS buyer_role, e.price::text AS price
      FROM bookings b JOIN events e ON e.id=b.event_id
      JOIN users owner ON owner.id=e.organizer_id JOIN users purchaser ON purchaser.id=b.user_id
      ORDER BY e.id`);
    assert.equal(joined.rowCount, 2);
    assert.deepEqual(joined.rows.map((row) => row.event_id), ids);
    assert.ok(joined.rows.every((row) => row.buyer_id === buyer && row.organizer_id === organizer && row.owner_role === "organizer" && row.buyer_role === "buyer" && row.price === "123.45"));
    const { rows: [aggregate] } = await client.query(`SELECT count(*)::int AS event_count,
      count(b.id)::int AS booking_count FROM events e LEFT JOIN bookings b ON b.event_id=e.id`);
    assert.deepEqual(aggregate, { event_count: 50000, booking_count: 2 });
    const { rows: [money] } = await client.query("SELECT sum(e.price)::text AS sum FROM bookings b JOIN events e ON e.id=b.event_id");
    assert.equal(money.sum, "246.90");

    await assert.rejects(() => client.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'duplicate')", [randomUUID(), `${buyer}@example.com`]), { code: "23505" });
    await assert.rejects(() => client.query("INSERT INTO bookings(id,user_id,event_id) VALUES($1,$2,$3)", [randomUUID(), randomUUID(), ids[0]]), { code: "23503" });
    for (const update of ["total_tickets=0", "remain_tickets=-1", "remain_tickets=101", "price=-0.01", "price='NaN'::numeric"]) {
      await assert.rejects(() => client.query(`UPDATE events SET ${update} WHERE id=$1`, [ids[0]]), { code: "23514" });
    }
    await assert.rejects(() => client.query("INSERT INTO events(id,title,total_tickets,remain_tickets,price) VALUES($1,'ownerless',1,1,1)", [randomUUID()]), { code: "23502" });
    await assert.rejects(() => client.query("UPDATE events SET organizer_id=$1 WHERE id=$2", [randomUUID(), ids[0]]), { code: "23503" });
    const key = randomUUID();
    await client.query("INSERT INTO idempotency_keys(key,user_id,request_hash,updated_at) VALUES($1,$2,'fixture',NOW()),($1,$3,'fixture',NOW())", [key, buyer, organizer]);
    await assert.rejects(() => client.query("INSERT INTO idempotency_keys(key,user_id,request_hash,updated_at) VALUES($1,$2,'duplicate',NOW())", [key, buyer]), { code: "23505" });

    const { rows: [{ indexdef }] } = await client.query("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname=$2", [schema, indexName]);
    await client.query(`DROP INDEX "${schema}"."${indexName}"`);
    await client.query("ANALYZE events");
    const { rows: cursorRows } = await client.query(`${firstPage.replace("LIMIT 51", "OFFSET 24999 LIMIT 1")}`);
    const cursor = [cursorRows[0].created_at, cursorRows[0].id];
    const before = await explain(client, firstPage);
    const cursorBefore = await explain(client, nextPage, cursor);
    await client.query(indexdef);
    await client.query("ANALYZE events");
    const after = await explain(client, firstPage);
    const cursorAfter = await explain(client, nextPage, cursor);
    assert.ok(nodes(before.Plan).some((entry) => entry["Node Type"] === "Sort"));
    assert.ok(nodes(after.Plan).some((entry) => entry["Index Name"] === indexName));
    assert.ok(nodes(cursorAfter.Plan).some((entry) => entry["Index Name"] === indexName));
    assert.equal(after.Plan["Actual Rows"], 51);
    assert.equal(cursorAfter.Plan["Actual Rows"], 51);
    const result = {
      identity, seededEvents: 50000, seededUsers: 2, seededBookings: 2,
      exercises: { join: "PASS", leftJoin: "PASS", exactMoneySum: money.sum, foreignKeys: "PASS", uniqueUserAndScopedKey: "PASS", inventoryAndPriceChecks: "PASS", ownerTrigger: "PASS" },
      query: firstPage, cursorQuery: nextPage, indexDefinition: indexdef,
      before: summary(before), after: summary(after), cursorBefore: summary(cursorBefore), cursorAfter: summary(cursorAfter),
      note: "Measured local samples; no latency threshold assertion or production throughput claim.",
    };
    saveEvidence("sql-exercises-and-plans.json", result);
    saveEvidence("catalog-before.json", before);
    saveEvidence("catalog-after.json", after);
    saveEvidence("catalog-cursor-before.json", cursorBefore);
    saveEvidence("catalog-cursor-after.json", cursorAfter);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    try {
      await client.query("ROLLBACK");
      if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally { client.release(true); await pool.end(); }
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
