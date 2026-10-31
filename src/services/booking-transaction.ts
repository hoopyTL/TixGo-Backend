import { ServiceUnavailableError } from "../errors/http-errors";
import { AppError } from "../errors/AppError";
import { Prisma } from "@prisma/client";
import { db } from "../configs/db";

function setting(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}

// Prisma raw queries and the pg adapter wrap SQLSTATE at different depths.
function codes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== "object" || depth > 6) return [];
  const value = error as Record<string, unknown>;
  return [value.code, value.originalCode, value.sqlState].filter((code): code is string => typeof code === "string")
    .concat(...[value.meta, value.cause, value.driverAdapterError].map((nested) => codes(nested, depth + 1)));
}

export async function withBookingTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const attempts = setting("BOOKING_RETRY_ATTEMPTS", 3, 10);
  const deadline = Date.now() + setting("BOOKING_RETRY_DEADLINE_MS", 10000, 120000);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // Reserve acquisition time so waiting for a pool connection cannot extend the total budget.
    const maxWait = Math.min(2000, Math.max(1, Math.floor(remaining / 3)));
    const timeout = Math.min(setting("BOOKING_TRANSACTION_TIMEOUT_MS", 5000, 60000), Math.max(1, remaining - maxWait));
    try {
      return await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${setting("BOOKING_LOCK_TIMEOUT_MS", 1000, 60000)}ms`}, true)`;
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${`${Math.max(1, timeout - 100)}ms`}, true)`;
        return work(tx);
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait, timeout,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const sqlCodes = codes(error);
      // Acquisition/statement/interactive timeouts also leave no committed partial writes.
      // Retrying preserves the original operation identity and remains within the same budget.
      const retryable = sqlCodes.some((code) => ["40P01", "40001", "55P03", "P2034", "57014", "P2028"].includes(code));
      if (!retryable) throw error;
      if (attempt === attempts || deadline - Date.now() < 100) break;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.floor(Math.random() * 50)));
    }
  }
  throw new ServiceUnavailableError("Booking is busy; retry with the same request identity", "BOOKING_BUSY", 1);
}
