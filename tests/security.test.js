const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const supertest = require("supertest");
const { startLab } = require("./lab/booking-server");

const execute = promisify(execFile);

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("Security regressions", () => {
  it("does not disclose the API framework in HTTP headers", async () => {
    const { app } = require("../dist/app");
    const server = createServer(app);
    try {
      const url = await listen(server);
      for (const route of ["/health", "/missing-route"]) {
        const response = await supertest(url).get(route);
        assert.equal(response.headers["x-powered-by"], undefined);
      }
    } finally {
      await close(server);
    }
  });

  it("does not disclose the isolated booking lab framework", async () => {
    const lab = await startLab({
      connectionString: "postgresql://unused:unused@127.0.0.1:1/header_test",
      schema: "header_test",
      mode: "locked",
      secret: "header-test-only",
    });
    try {
      const response = await supertest(lab.url).get("/missing-route");
      assert.equal(response.status, 404);
      assert.equal(response.headers["x-powered-by"], undefined);
    } finally {
      await lab.close();
    }
  });

  it("keeps remote booking data out of manual scenario logs", async () => {
    const eventId = "11111111-1111-4111-8111-111111111111";
    const remoteId = "REMOTE_BOOKING_ID\nFORGED_LOG_ENTRY";
    let purchases = 0;
    const server = createServer((request, response) => {
      request.resume();
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/auth/me") return response.end("{}");
      if (request.url === "/events") {
        return response.end(JSON.stringify([{ id: eventId, remainTickets: purchases ? 1 : 2 }]));
      }
      if (request.url === `/events/${eventId}/seats`) {
        return response.end(JSON.stringify({ data: [{ id: "fixture-seat", status: "AVAILABLE" }] }));
      }
      if (request.url === "/bookings/hold") {
        response.statusCode = 201;
        return response.end("{}");
      }
      if (request.url === "/bookings") {
        purchases += 1;
        if (purchases === 1) response.statusCode = 201;
        if (purchases === 2) response.setHeader("Idempotent-Replayed", "true");
        if (purchases === 3) response.statusCode = 400;
        return response.end(JSON.stringify({ data: { id: remoteId } }));
      }
      response.statusCode = 404;
      return response.end("{}");
    });
    try {
      const url = await listen(server);
      const { stdout } = await execute(process.execPath, [
        path.join(__dirname, "api-scenarios.js"), "idempotency", eventId, "fixture.token.signature",
      ], { env: { ...process.env, BASE_URL: url }, timeout: 10000 });
      assert.match(stdout, /PASS: create=201, replay=200/);
      assert.doesNotMatch(stdout, /REMOTE_BOOKING_ID|FORGED_LOG_ENTRY/);
      assert.equal(purchases, 3);
    } finally {
      await close(server);
    }
  });
});
