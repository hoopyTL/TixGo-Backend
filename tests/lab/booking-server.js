const express = require("express");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { randomUUID } = require("node:crypto");

// Deliberately unsafe algorithm lives exclusively in this isolated teaching lab.
async function startLab({ connectionString, schema, mode, secret, delayMs = 80, poolSize = 20 }) {
  const url = new URL(connectionString);
  if (!decodeURIComponent(url.pathname).endsWith("_test") || !/^[a-zA-Z0-9_]+$/.test(schema)) {
    throw new Error("The lab requires an isolated schema in a database ending in _test");
  }
  if (!["unsafe", "locked"].includes(mode)) throw new Error("Unknown lab algorithm");
  const pool = new Pool({ connectionString, max: poolSize, options: `-c search_path="${schema}" -c statement_timeout=10000` });
  const traces = [];
  const app = express();
  app.use(express.json());
  app.post("/bookings", async (req, res) => {
    const trace = { key: req.get("Idempotency-Key"), receivedAt: new Date().toISOString(), mode };
    let client;
    try {
      const actor = jwt.verify((req.get("Authorization") || "").replace(/^Bearer /, ""), secret);
      if (!trace.key || typeof req.body.eventId !== "string") return res.status(400).json({ code: "INVALID_REQUEST" });
      client = await pool.connect();
      await client.query("BEGIN");
      const { rows: [event] } = await client.query(
        `SELECT id, remain_tickets, clock_timestamp() AS read_at FROM lab_events WHERE id=$1${mode === "locked" ? " FOR UPDATE" : ""}`,
        [req.body.eventId],
      );
      trace.readAt = event?.read_at.toISOString();
      trace.readTickets = event?.remain_tickets;
      if (!event || event.remain_tickets < 1) {
        await client.query("ROLLBACK");
        trace.status = event ? 409 : 404;
        return res.status(trace.status).json({ code: event ? "SOLD_OUT" : "NOT_FOUND" });
      }
      // A documented artificial read/write window makes the lost update reproducible.
      await client.query("SELECT pg_sleep($1)", [delayMs / 1000]);
      const id = randomUUID();
      await client.query("INSERT INTO lab_bookings(id,event_id,user_id,request_key) VALUES($1,$2,$3,$4)", [id, event.id, actor.userId, trace.key]);
      await client.query("UPDATE lab_events SET remain_tickets=$2 WHERE id=$1", [event.id, event.remain_tickets - 1]);
      const { rows: [write] } = await client.query("SELECT clock_timestamp() AS write_at");
      trace.writeAt = write.write_at.toISOString();
      await client.query("COMMIT");
      trace.status = 201;
      res.status(201).json({ data: { id, eventId: event.id } });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      trace.status = error.name === "JsonWebTokenError" ? 401 : 500;
      trace.error = error.code || error.name;
      res.status(trace.status).json({ code: "LAB_ERROR" });
    } finally {
      if (client) client.release();
      trace.finishedAt = new Date().toISOString();
      traces.push(trace);
    }
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    traces,
    close: async () => { await new Promise((resolve) => server.close(resolve)); await pool.end(); },
  };
}

module.exports = { startLab };
