import "dotenv/config";
import { db } from "../configs/db";
import { closeReservationCache } from "../configs/redis";
import { ReservationService } from "../services/reservation.service";

let stopping = false;
let wake: (() => void) | undefined;
process.on("SIGINT", () => { stopping = true; wake?.(); });
process.on("SIGTERM", () => { stopping = true; wake?.(); });

async function run() {
  const poll = Number(process.env.RESERVATION_POLL_MS ?? 1000);
  const batch = Number(process.env.RESERVATION_BATCH_SIZE ?? 100);
  if (!Number.isSafeInteger(poll) || poll < 10 || poll > 60000) throw new Error("Invalid RESERVATION_POLL_MS");
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 1000) throw new Error("Invalid RESERVATION_BATCH_SIZE");
  let failures = 0;
  console.log(JSON.stringify({ event: "reservation_worker_started", pid: process.pid, poll, batch }));
  while (!stopping) {
    try {
      const started = Date.now();
      const [backlog] = await db.$queryRaw<{ oldestLagMs: number }[]>`
        SELECT (EXTRACT(EPOCH FROM (clock_timestamp()-expires_at))*1000)::double precision AS "oldestLagMs"
        FROM reservations WHERE status='HELD' AND expires_at <= clock_timestamp()
        ORDER BY expires_at,id LIMIT 1
      `;
      const expired = await ReservationService.expireBatch(batch, () => stopping);
      failures = 0;
      if (expired) console.log(JSON.stringify({ event: "reservations_expired", pid: process.pid, expired, oldestLagMs: backlog?.oldestLagMs ?? 0, elapsedMs: Date.now() - started }));
    } catch (error) {
      failures++;
      console.error(JSON.stringify({ event: "reservation_worker_failed", pid: process.pid, error: error instanceof Error ? error.message : "Unknown error" }));
    }
    if (!stopping) await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { wake = undefined; resolve(); }, Math.min(30000, poll * 2 ** Math.min(failures, 5)));
      wake = () => { clearTimeout(timer); resolve(); };
    });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await closeReservationCache();
  await db.$disconnect();
});
