import { Prisma } from "@prisma/client";
import { updateReservationCache } from "../configs/redis";
import { AppError } from "../errors/AppError";
import { generateRequestHash } from "../utils/hash";
import { CreateBookingInput } from "../validators/booking.validator";
import { lockCurrentActor } from "./access.service";
import { withBookingTransaction } from "./booking-transaction";
import { expireReservation, lockEvent } from "./reservation.service";

const bookingSelect = {
  id: true, userId: true, eventId: true, status: true, createdAt: true,
  seatId: true, reservationId: true,
} satisfies Prisma.BookingSelect;

export const BookingService = {
  getBooking: async (actorId: string, bookingId: string) => {
    return withBookingTransaction(async (tx) => {
      const actor = await lockCurrentActor(tx, actorId);
      const booking = await tx.booking.findFirst({
        where: { id: bookingId, ...(actor.role === "admin" ? {} : { userId: actor.id }) },
        select: bookingSelect,
      });
      if (!booking) throw new AppError(404, "Booking not found");
      return booking;
    });
  },

  cancelBooking: async (actorId: string, bookingId: string) => {
    return withBookingTransaction(async (tx) => {
      const actor = await lockCurrentActor(tx, actorId);
      const target = await tx.booking.findFirst({
        where: { id: bookingId, ...(actor.role === "admin" ? {} : { userId: actor.id }) },
        select: { eventId: true, reservationId: true },
      });
      if (!target) throw new AppError(404, "Booking not found");
      const event = await lockEvent(tx, target.eventId);
      if (target.reservationId) await tx.$queryRaw`SELECT id FROM reservations WHERE id=${target.reservationId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM bookings WHERE id=${bookingId} FOR UPDATE`;
      const booking = await tx.booking.findUnique({ where: { id: bookingId }, select: bookingSelect });
      if (!booking || (actor.role !== "admin" && booking.userId !== actor.id)) throw new AppError(404, "Booking not found");
      if (booking.eventId !== event.id) throw new AppError(409, "Booking changed during cancellation");
      if (booking.status === "CANCELLED") return booking;
      if (booking.status !== "CONFIRMED") throw new AppError(409, "Booking cannot be cancelled");
      if (event.remain_tickets < 0 || event.remain_tickets >= event.total_tickets) {
        throw new AppError(409, "Inventory cannot be restored within event capacity");
      }
      const cancelled = await tx.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED" }, select: bookingSelect });
      await tx.event.update({ where: { id: event.id }, data: { remainTickets: { increment: 1 } } });
      return cancelled;
    });
  },

  createBooking: async (userId: string, input: CreateBookingInput, idempotencyKey: string) => {
    const isConfirm = "reservationId" in input;
    const operation = isConfirm ? "booking.confirm.v2" : "booking.create.v1";
    const canonical = isConfirm
      ? { operation, eventId: input.eventId, seatId: input.seatId, reservationId: input.reservationId }
      : { eventId: input.eventId };
    const requestHash = generateRequestHash(userId, canonical);
    const outcome = await withBookingTransaction(async (tx) => {
      await lockCurrentActor(tx, userId);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([userId, idempotencyKey])},0))::text`;
      const existing = await tx.idempotency.findUnique({ where: { userId_key: { userId, key: idempotencyKey } } });
      if (existing) {
        if (existing.operation !== operation || existing.requestHash !== requestHash) throw new AppError(400, "Request hash mismatch");
        if (existing.status !== "COMPLETED") throw new AppError(409, "Request is processing", "REQUEST_IN_PROGRESS");
        if (!existing.responseBody) throw new Error("Committed idempotency result is missing");
        return { data: JSON.parse(existing.responseBody), cached: true };
      }
      if (!isConfirm) throw new AppError(400, "A seat reservation is required before booking", "RESERVATION_REQUIRED");
      await lockEvent(tx, input.eventId);
      await tx.$queryRaw`SELECT id FROM reservations WHERE id=${input.reservationId} FOR UPDATE`;
      const reservation = await tx.reservation.findFirst({ where: { id: input.reservationId, userId } });
      if (!reservation) throw new AppError(404, "Reservation not found");
      if (reservation.eventId !== input.eventId || reservation.seatId !== input.seatId) throw new AppError(400, "Reservation payload mismatch");
      if (reservation.status === "CONFIRMED") throw new AppError(409, "Reservation was already confirmed", "ALREADY_CONFIRMED");
      const changed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE reservations SET status='CONFIRMED',updated_at=clock_timestamp()
        WHERE id=${reservation.id} AND status='HELD' AND expires_at > clock_timestamp() RETURNING id
      `;
      if (!changed.length) {
        await expireReservation(tx, reservation.id);
        return { expired: await tx.reservation.findUniqueOrThrow({ where: { id: reservation.id } }) };
      }
      const booking = await tx.booking.create({
        data: { userId, eventId: input.eventId, seatId: input.seatId, reservationId: reservation.id }, select: bookingSelect,
      });
      await tx.idempotency.create({ data: {
        userId, key: idempotencyKey, operation, requestHash, status: "COMPLETED",
        responseStatus: 201, responseBody: JSON.stringify(booking),
      } });
      return { data: booking, cached: false, reservation: { ...reservation, status: "CONFIRMED" } };
    });
    if ("expired" in outcome && outcome.expired) {
      await updateReservationCache(outcome.expired);
      // The EXPIRED transition and inventory restoration must commit before returning conflict.
      const code = outcome.expired.status === "RELEASED" ? "RESERVATION_RELEASED" : "RESERVATION_EXPIRED";
      throw new AppError(409, "Reservation is no longer valid", code);
    }
    if ("reservation" in outcome && outcome.reservation) await updateReservationCache(outcome.reservation);
    return { data: outcome.data, cached: outcome.cached };
  },
};
