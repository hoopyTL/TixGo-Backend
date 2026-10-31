import { BadRequestError } from "../errors/http-errors";
import { z } from "zod";

export const HoldSchema = z.object({
  eventId: z.string().uuid(), seatId: z.string().uuid(), reservationId: z.string().uuid(),
}).strict();
// Event-only requests exist solely to replay historical, committed v1 results.
export const CreateBookingSchema = z.union([HoldSchema, z.object({ eventId: z.string().uuid() }).strict()]);
export type HoldInput = z.infer<typeof HoldSchema>;
export type CreateBookingInput = z.infer<typeof CreateBookingSchema>;

export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new BadRequestError("A valid Idempotency-Key header is required");
  }
  return value;
}
