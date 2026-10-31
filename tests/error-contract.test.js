const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { gzipSync } = require("node:zlib");
const path = require("node:path");
const { AppError } = require("../dist/errors/AppError");
const {
  BadRequestError, ValidationError, UnauthorizedError, ForbiddenError,
  NotFoundError, ConflictError, TooManyRequestsError, ServiceUnavailableError,
} = require("../dist/errors/http-errors");
const { asyncHandler, errorHandler, notFound } = require("../dist/middlewares/error.middleware");

process.env.JWT_SECRET ||= "error-contract-test-secret";
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:1/tixgo_test";

const execute = promisify(execFile);
const servers = new Set();

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.add(server);
  return server;
}

async function fixture(configure) {
  const app = express();
  app.use(express.json());
  configure(app);
  app.use(notFound);
  app.use(errorHandler);
  return listen(app);
}

function contract(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.match(response.headers["content-type"], /^application\/json/);
  assert.equal(typeof response.body.message, "string");
  assert.equal(response.body.code, code);
  assert.equal(response.body.requestId, undefined);
  assert.equal(response.headers["x-request-id"], undefined);
  assert.deepEqual(Object.keys(response.body).sort(), ["code", "message"]);
}

async function captureErrors(work) {
  const entries = [];
  const original = console.error;
  console.error = (...args) => entries.push(args);
  try {
    return { result: await work(), entries };
  } finally {
    console.error = original;
  }
}

describe("Application error contract", () => {
  afterEach(async () => {
    await Promise.all([...servers].map((server) => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    servers.clear();
  });

  it("preserves subclass identity and HTTP metadata across the Error hierarchy", () => {
    const errors = [
      [new BadRequestError("Invalid input"), 400, "BAD_REQUEST"],
      [new ValidationError("Invalid input"), 400, "VALIDATION_ERROR"],
      [new UnauthorizedError(), 401, "UNAUTHORIZED"],
      [new ForbiddenError(), 403, "FORBIDDEN"],
      [new NotFoundError(), 404, "NOT_FOUND"],
      [new ConflictError("Seat taken", "SEAT_UNAVAILABLE"), 409, "SEAT_UNAVAILABLE"],
      [new TooManyRequestsError("Slow down", 3), 429, "TOO_MANY_REQUESTS"],
      [new ServiceUnavailableError("Booking busy", "BOOKING_BUSY", 1), 503, "BOOKING_BUSY"],
    ];
    for (const [error, status, code] of errors) {
      assert.ok(error instanceof Error);
      assert.ok(error instanceof AppError);
      assert.ok(error instanceof error.constructor);
      assert.equal(error.name, error.constructor.name);
      assert.equal(error.statusCode, status);
      assert.equal(error.code, code);
    }
    assert.ok(errors[5][0] instanceof ConflictError);
    assert.equal(errors[6][0].retryAfterSeconds, 3);
    assert.equal(errors[7][0].retryAfterSeconds, 1);
  });

  it("keeps legacy AppError status fallbacks and existing booking codes", async () => {
    const cases = [
      [new AppError(400, "Bad input"), 400, "BAD_REQUEST"],
      [new AppError(401, "Sign in"), 401, "UNAUTHORIZED"],
      [new AppError(403, "Forbidden"), 403, "FORBIDDEN"],
      [new AppError(404, "Missing"), 404, "NOT_FOUND"],
      [new AppError(409, "Conflict"), 409, "CONFLICT"],
      [new AppError(429, "Rate limited"), 429, "TOO_MANY_REQUESTS"],
      ...["RESERVATION_EXPIRED", "RESERVATION_RELEASED", "ALREADY_CONFIRMED", "REQUEST_IN_PROGRESS", "SEAT_UNAVAILABLE", "SOLD_OUT"]
        .map((code) => [new ConflictError("Business conflict", code), 409, code]),
      [new BadRequestError("Reservation required", "RESERVATION_REQUIRED"), 400, "RESERVATION_REQUIRED"],
    ];
    const server = await fixture((app) => app.get("/failure/:index", asyncHandler((req) => {
      throw cases[Number(req.params.index)][0];
    })));
    for (const [index, [error, status, code]] of cases.entries()) {
      const response = await request(server).get(`/failure/${index}`);
      contract(response, status, code);
      assert.equal(response.body.message, error.message);
    }
  });

  it("turns malformed, oversized and unsupported JSON bodies into safe JSON errors", async () => {
    const server = await fixture((app) => app.post("/body", (_req, res) => res.json({ ok: true })));
    for (const [contentType, encoding, body, status, code] of [
      ["application/json", undefined, "{private-input", 400, "REQUEST_ERROR"],
      ["application/json", undefined, JSON.stringify({ value: "x".repeat(110000) }), 413, "REQUEST_ERROR"],
      ["application/json; charset=bogus", undefined, "{}", 415, "REQUEST_ERROR"],
      ["application/json", "bogus", "{}", 415, "REQUEST_ERROR"],
    ]) {
      const attempt = request(server).post("/body").set("Content-Type", contentType);
      if (encoding) attempt.set("Content-Encoding", encoding);
      const response = await attempt.send(body);
      contract(response, status, code);
      assert.equal(response.body.message, "Request failed");
      assert.doesNotMatch(JSON.stringify(response.body), /private-input|bogus|SyntaxError|stack/);
    }
  });

  it("keeps malformed and truncated compressed request bodies at 400 without logging a server failure", async () => {
    const privateInput = "PRIVATE_COMPRESSED_INPUT";
    const compressed = gzipSync(JSON.stringify({ value: privateInput }));
    const bodies = [Buffer.from(privateInput), compressed.subarray(0, compressed.length - 6)];
    const server = await fixture((app) => app.post("/body", (_req, res) => res.json({ ok: true })));
    const messages = [];
    const { entries } = await captureErrors(async () => {
      for (const body of bodies) {
        const response = await request(server).post("/body")
          .set("Content-Type", "application/json")
          .set("Content-Encoding", "gzip")
          .send(body);
        contract(response, 400, "REQUEST_ERROR");
        assert.equal(response.body.message, "Request failed");
        assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE_COMPRESSED_INPUT|incorrect header|unexpected end|Z_DATA_ERROR|Z_BUF_ERROR|stack/i);
        messages.push(response.body.message);
      }
    });
    assert.equal(messages[0], messages[1]);
    assert.equal(entries.length, 0);
  });

  it("keeps malformed URL parameters at 400 without exposing the parameter or logging a server failure", async () => {
    const { app } = require("../dist/app");
    const server = await listen(app);
    const { result: response, entries } = await captureErrors(() => request(server).get("/events/%ZZ/seats"));
    contract(response, 400, "REQUEST_ERROR");
    assert.equal(response.body.message, "Request failed");
    assert.doesNotMatch(JSON.stringify(response.body), /%ZZ|Failed to decode|URIError|stack/);
    assert.equal(entries.length, 0);
  });

  it("catches both sync throws and async rejections, including falsy rejected values, exactly once", async () => {
    const values = [new Error("Unexpected failure"), undefined, null, false, "rejected text"];
    let forwarded = 0;
    const server = await fixture((app) => {
      app.get("/sync/:index", asyncHandler((req) => { throw values[Number(req.params.index)]; }));
      app.get("/async/:index", asyncHandler(async (req) => {
        await Promise.resolve();
        throw values[Number(req.params.index)];
      }));
      app.use((error, _req, _res, next) => { forwarded++; next(error); });
    });
    const { entries } = await captureErrors(async () => {
      for (const mode of ["sync", "async"]) {
        for (const index of values.keys()) {
          const response = await request(server).get(`/${mode}/${index}`);
          contract(response, 500, "INTERNAL_ERROR");
          assert.equal(response.body.message, "Internal server error");
        }
      }
    });
    assert.equal(forwarded, 10);
    assert.equal(entries.length, 10);
  });

  it("preserves valid status fields, prefers statusCode and hides non-AppError diagnostics", async () => {
    const failure = (fields) => Object.assign(new Error("PRIVATE_FRAMEWORK_MESSAGE"), {
      code: "PRIVATE_FRAMEWORK_CODE", expose: true, ...fields,
    });
    const cases = [
      [new SyntaxError("PRIVATE_FRAMEWORK_MESSAGE"), 500],
      [failure({ status: 400 }), 400],
      [failure({ statusCode: 413 }), 413],
      [failure({ status: 415, type: "unknown.parser.type" }), 415],
      [failure({ statusCode: 429 }), 429],
      [failure({ statusCode: 503 }), 503],
      [failure({ statusCode: 400, status: 503 }), 400],
      [failure({ statusCode: null, status: 415 }), 415],
      ...[200, 600, NaN, Infinity, 400.5, "400"].map((statusCode) => [failure({ statusCode, status: 400 }), 500]),
    ];
    const server = await fixture((app) => app.get("/failure/:index", asyncHandler((req) => {
      throw cases[Number(req.params.index)][0];
    })));
    const { entries } = await captureErrors(async () => {
      for (const [index, [, status]] of cases.entries()) {
        const response = await request(server).get(`/failure/${index}`);
        contract(response, status, status < 500 ? "REQUEST_ERROR" : "INTERNAL_ERROR");
        assert.equal(response.body.message, status < 500 ? "Request failed" : "Internal server error");
        assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE_FRAMEWORK|SyntaxError|stack/);
      }
    });
    assert.equal(entries.length, cases.filter(([, status]) => status >= 500).length);
  });

  it("returns 500 for invalid AppError statuses and hides internal AppError messages", async () => {
    const cases = [
      ...[99, 200, 600, NaN, 400.5].map((status) => [new AppError(status, "Secret status"), 500, "INTERNAL_ERROR"]),
      [new AppError(500, "Secret internal failure", "PRIVATE_FAILURE"), 500, "INTERNAL_ERROR"],
      [new AppError(503, "Secret unavailable failure", "PRIVATE_FAILURE"), 503, "SERVICE_UNAVAILABLE"],
    ];
    const server = await fixture((app) => app.get("/failure/:index", asyncHandler((req) => {
      throw cases[Number(req.params.index)][0];
    })));
    await captureErrors(async () => {
      for (const [index, [, status, code]] of cases.entries()) {
        const response = await request(server).get(`/failure/${index}`);
        contract(response, status, code);
        assert.doesNotMatch(JSON.stringify(response.body), /Secret|PRIVATE_FAILURE/);
      }
    });
  });

  it("keeps Zod validation and transforms while returning only an error message and code", async () => {
    const { validate } = require("../dist/middlewares/validate.middleware");
    const { RegisterSchema } = require("../dist/validators/auth.validator");
    let reached = 0;
    const server = await fixture((app) => app.post("/validate", validate(RegisterSchema), (req, res) => {
      reached++;
      res.json({ email: req.body.email });
    }));
    for (const body of [
      { email: "invalid", password: "short" },
      { email: "buyer@example.test", password: "Valid-password", unexpected: true },
      {},
      [],
    ]) {
      const response = await request(server).post("/validate").send(body);
      contract(response, 400, "VALIDATION_ERROR");
      assert.equal(response.body.message, "Dữ liệu không hợp lệ");
    }
    assert.equal(reached, 0);
    const valid = await request(server).post("/validate")
      .send({ email: "Buyer@Example.test", password: "Valid-password" });
    assert.equal(valid.status, 200);
    assert.deepEqual(valid.body, { email: "buyer@example.test" });
    assert.equal(reached, 1);
  });

  it("preserves retry guidance for throttling and busy bookings, excluding invalid metadata", async () => {
    const cases = [
      [new TooManyRequestsError("Slow down", 7), 429, "TOO_MANY_REQUESTS", "7"],
      [new ServiceUnavailableError("Booking busy", "BOOKING_BUSY", 1), 503, "BOOKING_BUSY", "1"],
      ...[0, -1, 1.5, NaN, Infinity].map((value) => [new AppError(429, "Slow down", undefined, { retryAfterSeconds: value }), 429, "TOO_MANY_REQUESTS", undefined]),
    ];
    const server = await fixture((app) => app.get("/failure/:index", asyncHandler((req) => {
      throw cases[Number(req.params.index)][0];
    })));
    await captureErrors(async () => {
      for (const [index, [, status, code, retryAfter]] of cases.entries()) {
        const response = await request(server).get(`/failure/${index}`);
        contract(response, status, code);
        assert.equal(response.headers["retry-after"], retryAfter);
      }
    });
  });

  it("keeps success and error responses free of request IDs, including client-supplied IDs", async () => {
    const server = await fixture((app) => {
      app.get("/success", asyncHandler(async (_req, res) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        res.json({ data: "unchanged" });
      }));
    });
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => {
      return request(server).get(index % 2 ? "/success" : "/missing").set("X-Request-ID", "untrusted-client-id");
    }));
    for (const response of responses) {
      assert.equal(response.headers["x-request-id"], undefined);
      assert.equal(response.body.requestId, undefined);
      if (response.status === 200) assert.equal(response.body.data, "unchanged");
      else contract(response, 404, "NOT_FOUND");
    }
  });

  it("logs unexpected failures once without request IDs, secrets or raw URLs", async () => {
    const sentinel = "PRIVATE_SECRET_SENTINEL";
    const failure = new Error(`postgresql://user:${sentinel}@database/private SELECT password`);
    failure.stack = `${sentinel} private stack`;
    const server = await fixture((app) => app.post("/failure/:id", asyncHandler(async () => { throw failure; })));
    const { result: response, entries } = await captureErrors(() => request(server)
      .post(`/failure/${sentinel}?token=${sentinel}`)
      .set("Authorization", `Bearer ${sentinel}`)
      .set("Cookie", `session=${sentinel}`)
      .send({ password: sentinel }));
    contract(response, 500, "INTERNAL_ERROR");
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(sentinel));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].length, 1);
    const log = JSON.parse(entries[0][0]);
    assert.equal(log.requestId, undefined);
    assert.equal(log.statusCode, 500);
    assert.equal(log.code, "INTERNAL_ERROR");
    assert.equal(log.method, "POST");
    assert.equal(log.route, "/failure/:id");
    const allowed = new Set(["timestamp", "level", "event", "method", "route", "statusCode", "code"]);
    assert.ok(Object.keys(log).every((key) => allowed.has(key)));
    assert.doesNotMatch(JSON.stringify(log), new RegExp(`${sentinel}|SELECT|postgresql|private stack`));
  });

  it("delegates after headers are sent without writing or logging another response", async () => {
    const failure = new Error("Already streaming");
    let forwarded;
    const { entries } = await captureErrors(async () => {
      errorHandler(failure, {}, { headersSent: true }, (error) => { forwarded = error; });
    });
    assert.equal(forwarded, failure);
    assert.equal(entries.length, 0);
  });

  it("uses the contract on real app health, fallback, auth, body validation and resource validation paths", async () => {
    const { app } = require("../dist/app");
    const { signToken } = require("../dist/utils/jwt");
    const server = await listen(app);
    const health = await request(server).get("/health");
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: "Ok" });
    assert.equal(health.headers["x-request-id"], undefined);
    contract(await request(server).get("/missing-contract-route"), 404, "NOT_FOUND");
    contract(await request(server).post("/bookings").send({}), 401, "UNAUTHORIZED");
    contract(await request(server).get("/auth/me").set("Authorization", "Bearer invalid"), 401, "UNAUTHORIZED");
    const validation = await request(server).post("/auth/register").send({ email: "invalid", password: "short" });
    contract(validation, 400, "VALIDATION_ERROR");
    assert.equal(validation.body.message, "Dữ liệu không hợp lệ");
    const token = signToken({ userId: randomUUID(), role: "buyer" });
    contract(await request(server).get("/bookings/invalid-id").set("Authorization", `Bearer ${token}`), 400, "BAD_REQUEST");
    contract(await request(server).get("/events?limit=invalid"), 400, "BAD_REQUEST");
    const head = await request(server).head("/missing-contract-route");
    assert.equal(head.status, 404);
    assert.equal(head.headers["x-request-id"], undefined);
    assert.equal(head.text, undefined);
  });

  it("forwards service rejections through every real async controller route", async function () {
    this.timeout(10000);
    const { app } = require("../dist/app");
    const { signToken } = require("../dist/utils/jwt");
    const { AuthService } = require("../dist/services/auth.service");
    const { EventService } = require("../dist/services/event.service");
    const { BookingService } = require("../dist/services/booking.service");
    const { ReservationService } = require("../dist/services/reservation.service");
    const server = await listen(app);
    const id = randomUUID();
    const token = signToken({ userId: randomUUID(), role: "organizer" });
    const authBody = { email: "contract@example.test", password: "Contract-test-password" };
    const holdBody = { eventId: id, seatId: randomUUID(), reservationId: randomUUID() };
    const routes = [
      [AuthService, "register", "post", "/auth/register", authBody],
      [AuthService, "login", "post", "/auth/login", authBody],
      [EventService, "getAllEvents", "get", "/events"],
      [EventService, "createEvent", "post", "/events", { title: "Contract", totalTickets: 1, price: "1.00" }],
      [EventService, "updateEvent", "patch", `/events/${id}`, { title: "Contract" }],
      [BookingService, "getBooking", "get", `/bookings/${id}`],
      [BookingService, "cancelBooking", "post", `/bookings/${id}/cancel`, {}],
      [BookingService, "createBooking", "post", "/bookings", holdBody],
      [ReservationService, "hold", "post", "/bookings/hold", holdBody],
      [ReservationService, "get", "get", `/bookings/holds/${id}`],
      [ReservationService, "release", "delete", `/bookings/holds/${id}`],
      [ReservationService, "listSeats", "get", `/events/${id}/seats`],
    ];
    const { entries } = await captureErrors(async () => {
      for (const [service, method, verb, route, body] of routes) {
        const original = service[method];
        let calls = 0;
        try {
          for (const failure of [new ForbiddenError("Not allowed"), new Error("Internal service failure")]) {
            service[method] = async () => { calls++; throw failure; };
            const attempt = request(server)[verb](route)
              .set("Authorization", `Bearer ${token}`)
              .set("Idempotency-Key", "contract-test-key");
            if (body !== undefined) attempt.send(body);
            const response = await attempt;
            contract(response, failure instanceof AppError ? 403 : 500,
              failure instanceof AppError ? "FORBIDDEN" : "INTERNAL_ERROR");
          }
          assert.equal(calls, 2, `${method} must be reached through its route`);
        } finally {
          service[method] = original;
        }
      }
    });
    assert.equal(entries.length, routes.length);
  });

  it("returns JSON for malformed input and missing routes in production", async () => {
    const source = `
      const assert = require('node:assert/strict');
      const request = require('supertest');
      const { app } = require('./dist/app');
      const { db } = require('./dist/configs/db');
      const server = app.listen(0, '127.0.0.1');
      (async () => {
        await new Promise(resolve => server.once('listening', resolve));
        for (const response of [
          await request(server).get('/missing-contract-route'),
          await request(server).post('/auth/login').set('Content-Type', 'application/json').send('{bad'),
        ]) {
          assert.match(response.headers['content-type'], /^application\\/json/);
          assert.equal(response.body.requestId, undefined);
          assert.equal(response.headers['x-request-id'], undefined);
          assert.ok(['NOT_FOUND', 'REQUEST_ERROR'].includes(response.body.code));
        }
      })().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
        await new Promise(resolve => server.close(resolve));
        await db.$disconnect();
      });
    `;
    await execute(process.execPath, ["-e", source], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, NODE_ENV: "production", ENABLE_TEST_UI: "false" },
      timeout: 10000,
    });
  });
});
