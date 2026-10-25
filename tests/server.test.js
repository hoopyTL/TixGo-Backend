const supertest = require("supertest");
let apiServer;
function request(target) {
  return supertest(target === app ? apiServer : target);
}
const assert = require("node:assert/strict");

process.env.JWT_SECRET = "smoke-test-secret-only";
process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:1/tixgo_test";
process.env.NODE_ENV = "test";
delete process.env.ENABLE_TEST_UI;
const { app } = require("../dist/app");
const { db } = require("../dist/configs/db");

before(async () => {
  apiServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => apiServer.once("listening", resolve));
});
after(async () => {
  if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
  await db.$disconnect();
});

describe("API smoke tests (no database required)", () => {
  it("returns health", async () => {
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "BROKEN_FOR_CI_PROOF" });
  });
  it("returns 404 for an unknown route", async () => {
    assert.equal((await request(app).get("/missing-route")).status, 404);
  });
  it("rejects unauthenticated booking requests", async () => {
    const res = await request(app).post("/bookings").send({ eventId: "not-a-uuid" });
    assert.equal(res.status, 401);
  });
  it("rejects invalid and expired tokens", async () => {
    const jwt = require("jsonwebtoken");
    for (const token of [
      "invalid",
      jwt.sign({ userId: "test", role: "buyer" }, process.env.JWT_SECRET, { expiresIn: -1 }),
      jwt.sign({ userId: "test", role: "buyer" }, "different-test-secret"),
      jwt.sign({ role: "organizer" }, process.env.JWT_SECRET),
      jwt.sign({ userId: 42, role: "organizer" }, process.env.JWT_SECRET),
      jwt.sign({ userId: " ", role: "organizer" }, process.env.JWT_SECRET),
    ]) {
      const res = await request(app).get("/auth/me").set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 401);
      assert.equal((await request(app).post("/events").set("Authorization", `Bearer ${token}`)
        .send({ title: "Test", totalTickets: 1, price: 1 })).status, 401);
    }
  });
  it("rejects invalid auth payloads before database access", async () => {
    const res = await request(app).post("/auth/register").send({ email: "invalid", password: "short" });
    assert.equal(res.status, 400);
    assert.ok(res.body.details.email);
    assert.ok(res.body.details.password);
  });
  it("requires authentication before validating event input", async () => {
    const res = await request(app).post("/events").send({ title: "", totalTickets: -1, price: -1 });
    assert.equal(res.status, 401);
  });

});
