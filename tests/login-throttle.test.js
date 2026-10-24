const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { createLoginRateLimiter } = require("../dist/middlewares/login-rate-limit.middleware");
const { validate } = require("../dist/middlewares/validate.middleware");
const { LoginSchema } = require("../dist/validators/auth.validator");

const servers = new Set();

async function fixture(options = {}) {
  let time = 0;
  let reached = 0;
  const app = express();
  app.use(express.json());
  app.post("/login", createLoginRateLimiter({ ...options, now: () => time }), validate(LoginSchema), (req, res) => {
    reached++;
    return res.sendStatus(req.body.password === "correct" ? 200 : 401);
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.add(server);
  return { app: server, setTime: value => { time = value; }, reached: () => reached };
}

function attempt(app, email = "buyer@example.com", password = "wrong", headers = {}) {
  return request(app).post("/login").set(headers).send({ email, password });
}

describe("Login throttling over HTTP", () => {
  afterEach(async () => {
    await Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve))));
    servers.clear();
  });
  it("allows five default attempts and blocks the sixth before the handler", async () => {
    const test = await fixture();
    for (let index = 0; index < 5; index++) assert.equal((await attempt(test.app)).status, 401);
    const blocked = await attempt(test.app);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers["retry-after"], "900");
    assert.equal(test.reached(), 5);
    assert.deepEqual(blocked.body, { error: "Too many login attempts. Try again later." });
  });

  it("counts successful attempts in the same budget", async () => {
    const test = await fixture({ principalLimit: 2 });
    assert.equal((await attempt(test.app, "buyer@example.com", "correct")).status, 200);
    assert.equal((await attempt(test.app, "buyer@example.com", "correct")).status, 200);
    assert.equal((await attempt(test.app, "buyer@example.com", "correct")).status, 429);
    assert.equal(test.reached(), 2);
  });

  it("normalizes email case and surrounding whitespace before validation", async () => {
    const test = await fixture({ principalLimit: 2 });
    assert.equal((await attempt(test.app, " Buyer@Example.com ")).status, 400);
    assert.equal((await attempt(test.app, "buyer@example.com")).status, 401);
    assert.equal((await attempt(test.app, "BUYER@EXAMPLE.COM")).status, 429);
  });

  it("limits one IP across attempts with different email addresses", async () => {
    const test = await fixture({ principalLimit: 5, ipLimit: 2 });
    assert.equal((await attempt(test.app, "one@example.com")).status, 401);
    assert.equal((await attempt(test.app, "two@example.com")).status, 401);
    assert.equal((await attempt(test.app, "three@example.com")).status, 429);
    assert.equal(test.reached(), 2);
  });

  it("does not trust spoofed X-Forwarded-For headers", async () => {
    const test = await fixture({ principalLimit: 2 });
    assert.equal((await attempt(test.app, "buyer@example.com", "wrong", { "X-Forwarded-For": "192.0.2.1" })).status, 401);
    assert.equal((await attempt(test.app, "buyer@example.com", "wrong", { "X-Forwarded-For": "192.0.2.2" })).status, 401);
    assert.equal((await attempt(test.app, "buyer@example.com", "wrong", { "X-Forwarded-For": "192.0.2.3" })).status, 429);
    assert.equal(test.reached(), 2);
  });

  it("returns a positive rounded Retry-After and opens a new window at the boundary", async () => {
    const test = await fixture({ principalLimit: 1, windowMs: 1500 });
    assert.equal((await attempt(test.app)).status, 401);
    test.setTime(1);
    assert.equal((await attempt(test.app)).headers["retry-after"], "2");
    test.setTime(1499);
    const blocked = await attempt(test.app);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers["retry-after"], "1");
    test.setTime(1500);
    assert.equal((await attempt(test.app)).status, 401);
    assert.equal(test.reached(), 2);
  });

  it("counts structurally invalid payloads before validation rejects them", async () => {
    const test = await fixture({ principalLimit: 2 });
    assert.equal((await request(test.app).post("/login").send({})).status, 400);
    assert.equal((await request(test.app).post("/login").send({ email: 12, password: "wrong" })).status, 400);
    assert.equal((await request(test.app).post("/login").send({})).status, 429);
    assert.equal(test.reached(), 0);
  });

  it("fails closed at store capacity without evicting an active budget", async () => {
    const test = await fixture({ principalLimit: 2, ipLimit: 100, maxEntries: 2, windowMs: 1000 });
    assert.equal((await attempt(test.app, "original@example.com")).status, 401);
    for (let index = 0; index < 10; index++) {
      const blocked = await attempt(test.app, `other-${index}@example.com`);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers["retry-after"], "1");
    }
    assert.equal((await attempt(test.app, "original@example.com")).status, 401);
    assert.equal((await attempt(test.app, "original@example.com")).status, 429);
    test.setTime(1000);
    assert.equal((await attempt(test.app, "new@example.com")).status, 401);
  });

  it("does not extend a blocked fixed window when more attempts arrive", async () => {
    const test = await fixture({ principalLimit: 1, windowMs: 3000 });
    assert.equal((await attempt(test.app)).status, 401);
    test.setTime(1000);
    assert.equal((await attempt(test.app)).headers["retry-after"], "2");
    test.setTime(2000);
    assert.equal((await attempt(test.app)).headers["retry-after"], "1");
    test.setTime(3000);
    assert.equal((await attempt(test.app)).status, 401);
  });
});
