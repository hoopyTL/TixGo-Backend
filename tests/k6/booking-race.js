import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import exec from "k6/execution";

const created = new Counter("booking_created");
const soldOut = new Counter("booking_sold_out");
const unexpected = new Counter("booking_unexpected");
export const options = {
  scenarios: { race: { executor: "per-vu-iterations", vus: 100, iterations: 1, maxDuration: "30s" } },
  thresholds: { checks: ["rate==1"], booking_unexpected: ["count==0"], http_reqs: ["count==100"] },
};

export default function () {
  http.setResponseCallback(http.expectedStatuses(201, 409));
  const response = http.post(`${__ENV.BASE_URL}/bookings`, JSON.stringify({ eventId: __ENV.EVENT_ID }), {
    headers: { Authorization: `Bearer ${__ENV.TOKEN}`, "Content-Type": "application/json", "Idempotency-Key": `${__ENV.RUN_ID}-${exec.vu.idInTest}` },
    timeout: "20s",
    tags: { operation: "booking", algorithm: __ENV.MODE },
  });
  created.add(response.status === 201 ? 1 : 0);
  soldOut.add(response.status === 409 ? 1 : 0);
  unexpected.add(response.status !== 201 && response.status !== 409 ? 1 : 0);
  check(response, { "created or valid sold-out": (r) => r.status === 201 || (r.status === 409 && r.json("code") === "SOLD_OUT") });
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_PATH]: JSON.stringify(data, null, 2) };
}
