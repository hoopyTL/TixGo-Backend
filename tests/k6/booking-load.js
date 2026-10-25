import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import exec from "k6/execution";

const fixture = JSON.parse(open(__ENV.FIXTURE_PATH));
const create = new Counter("booking_created");
const conflict = new Counter("business_conflict");
const held = new Counter("hold_created");
const unexpected = new Counter("unexpected_outcome");
const toInstance = fixture.baseUrls.map((_, index) => new Counter(`instance_${index + 1}_requests`));
const requestCount = fixture.mode === "confirm" ? 5000 : 5100;
export const options = {
  scenarios: { booking: { executor: "per-vu-iterations", vus: 100, iterations: 50, maxDuration: "120s", gracefulStop: "5s" } },
  thresholds: {
    checks: ["rate==1"], unexpected_outcome: ["count==0"],
    http_reqs: [`count==${requestCount}`], iterations: ["count==5000"],
    booking_created: ["count==100"], business_conflict: ["count==4900"],
    ...(fixture.mode === "hold" ? { hold_created: ["count==100"] } : {}),
  },
};

function call(instance, endpoint, body, key) {
  toInstance[instance].add(1);
  return http.post(`${fixture.baseUrls[instance]}${endpoint}`, JSON.stringify(body), {
    headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    timeout: "20s", tags: { instance: String(instance + 1), operation: endpoint === "/bookings" ? "confirm" : "hold" },
  });
}

export default function () {
  http.setResponseCallback(http.expectedStatuses(200, 201, 409));
  const attempt = exec.scenario.iterationInTest;
  const instance = attempt % fixture.baseUrls.length;
  const key = `${fixture.runId}-${fixture.eventId}-${fixture.mode}-${attempt}`;
  let response;
  if (fixture.mode === "confirm") {
    const reservation = fixture.reservations[(exec.vu.idInTest - 1) % fixture.reservations.length];
    response = call(instance, "/bookings", { eventId: fixture.eventId, seatId: reservation.seatId, reservationId: reservation.reservationId }, key);
  } else {
    const seat = fixture.seats[attempt % fixture.seats.length];
    const reservationId = `${fixture.uuidPrefix}${attempt.toString(16).padStart(12, "0")}`;
    const hold = call(instance, "/bookings/hold", { eventId: fixture.eventId, seatId: seat.id, reservationId });
    held.add(hold.status === 201 ? 1 : 0);
    if (hold.status === 201) {
      response = call(instance, "/bookings", { eventId: fixture.eventId, seatId: seat.id, reservationId }, key);
      check(response, { "new hold confirms": (r) => r.status === 201 });
    } else response = hold;
  }
  let code;
  try { code = response.json("code"); } catch (_) { code = "INVALID_RESPONSE"; }
  const isCreated = response.status === 201;
  const isConflict = response.status === 409 && code === (fixture.mode === "confirm" ? "ALREADY_CONFIRMED" : "SEAT_UNAVAILABLE");
  if (!isCreated && !isConflict) console.error(`unexpected status=${response.status} code=${code} attempt=${attempt} instance=${instance + 1}`);
  create.add(isCreated ? 1 : 0);
  conflict.add(isConflict ? 1 : 0);
  unexpected.add(!isCreated && !isConflict ? 1 : 0);
  check(response, { "only valid business outcomes": () => isCreated || isConflict });
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_PATH]: JSON.stringify(data, null, 2) };
}
