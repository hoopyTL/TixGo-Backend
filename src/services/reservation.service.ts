import { Prisma } from "@prisma/client";
import { db } from "../configs/db";
import { updateReservationCache } from "../configs/redis";
import { AppError } from "../errors/AppError";
import { HoldInput } from "../validators/booking.validator";
import { lockCurrentActor } from "./access.service";
import { withBookingTransaction } from "./booking-transaction";

export async function lockEvent(tx: Prisma.TransactionClient, eventId: string) {
  const [event] = await tx.$queryRaw<{ id: string; total_tickets: number; remain_tickets: number }[]>`
    SELECT id,total_tickets,remain_tickets FROM events WHERE id=${eventId} FOR UPDATE
  `;
  if (!event) throw new AppError(404, "Event not found");
  return event;
}

async function lockReservation(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM reservations WHERE id=${id} FOR UPDATE`;
  return tx.reservation.findUnique({ where: { id } });
}

export async function expireReservation(tx: Prisma.TransactionClient, id: string) {
  const changed = await tx.$queryRaw<{ event_id: string }[]>`
    UPDATE reservations SET status='EXPIRED',updated_at=clock_timestamp()
    WHERE id=${id} AND status='HELD' AND expires_at <= clock_timestamp() RETURNING event_id
  `;
  if (changed.length) await tx.event.update({ where: { id: changed[0]!.event_id }, data: { remainTickets: { increment: 1 } } });
  return changed.length;
}

async function ownedReservation(tx: Prisma.TransactionClient, userId: string, id: string) {
  const target = await tx.reservation.findFirst({ where: { id, userId }, select: { eventId: true } });
  if (!target) throw new AppError(404, "Reservation not found");
  await lockEvent(tx, target.eventId);
  const reservation = await lockReservation(tx, id);
  if (!reservation || reservation.userId !== userId) throw new AppError(404, "Reservation not found");
  return reservation;
}

function ttl() {
  const value = Number(process.env.RESERVATION_TTL_SECONDS ?? 300);
  if (!Number.isFinite(value) || value <= 0 || value > 86400) throw new Error("Invalid RESERVATION_TTL_SECONDS");
  return value;
}

export const ReservationService = {
  hold: async (userId: string, input: HoldInput) => {
    const outcome = await withBookingTransaction(async (tx) => {
      await lockCurrentActor(tx, userId);
      // Share the same request-identity namespace across events before Event locking.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reservation:${input.reservationId}`},0))::text`;
      await lockEvent(tx, input.eventId);
      const seat = await tx.seat.findFirst({ where: { id: input.seatId, eventId: input.eventId } });
      if (!seat) throw new AppError(404, "Seat not found for event");
      const existing = await lockReservation(tx, input.reservationId);
      if (existing) {
        if (existing.userId !== userId) throw new AppError(404, "Reservation not found");
        if (existing.eventId !== input.eventId || existing.seatId !== input.seatId) throw new AppError(400, "Reservation payload mismatch");
        await expireReservation(tx, existing.id);
        const current = await tx.reservation.findUniqueOrThrow({ where: { id: existing.id } });
        return { reservation: current, cached: true, conflict: current.status !== "HELD" };
      }
      const prior = await tx.reservation.findFirst({ where: { seatId: input.seatId, status: "HELD" } });
      if (prior) await expireReservation(tx, prior.id);
      const occupied = await tx.reservation.count({ where: { seatId: input.seatId, status: "HELD" } });
      const booked = await tx.booking.count({ where: { seatId: input.seatId, status: "CONFIRMED" } });
      if (occupied || booked) throw new AppError(409, "Seat is unavailable", "SEAT_UNAVAILABLE");
      const event = await tx.event.findUniqueOrThrow({ where: { id: input.eventId } });
      if (event.remainTickets <= 0) throw new AppError(409, "Event is sold out", "SOLD_OUT");
      const [created] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO reservations(id,user_id,event_id,seat_id,status,created_at,expires_at,updated_at)
        SELECT ${input.reservationId},${userId},${input.eventId},${input.seatId},'HELD',t,t+(${ttl()} * interval '1 second'),t
        FROM (SELECT clock_timestamp() AS t) stamp RETURNING id
      `;
      await tx.event.update({ where: { id: input.eventId }, data: { remainTickets: { decrement: 1 } } });
      const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: created!.id } });
      return { reservation, cached: false, conflict: false };
    });
    await updateReservationCache(outcome.reservation);
    if (outcome.conflict) {
      const code = outcome.reservation.status === "CONFIRMED" ? "ALREADY_CONFIRMED"
        : outcome.reservation.status === "RELEASED" ? "RESERVATION_RELEASED" : "RESERVATION_EXPIRED";
      throw new AppError(409, "Reservation is no longer held", code);
    }
    return { data: outcome.reservation, cached: outcome.cached };
  },

  get: async (userId: string, id: string) => {
    const reservation = await withBookingTransaction(async (tx) => {
      await lockCurrentActor(tx, userId);
      await ownedReservation(tx, userId, id);
      await expireReservation(tx, id);
      return tx.reservation.findUniqueOrThrow({ where: { id } });
    });
    await updateReservationCache(reservation);
    return reservation;
  },

  release: async (userId: string, id: string) => {
    const reservation = await withBookingTransaction(async (tx) => {
      await lockCurrentActor(tx, userId);
      const current = await ownedReservation(tx, userId, id);
      if (current.status === "CONFIRMED") throw new AppError(409, "Reservation was confirmed", "ALREADY_CONFIRMED");
      await expireReservation(tx, id);
      const changed = await tx.reservation.updateMany({ where: { id, status: "HELD" }, data: { status: "RELEASED" } });
      if (changed.count) await tx.event.update({ where: { id: current.eventId }, data: { remainTickets: { increment: 1 } } });
      return tx.reservation.findUniqueOrThrow({ where: { id } });
    });
    await updateReservationCache(reservation);
  },

  listSeats: async (eventId: string) => {
    if (!await db.event.findUnique({ where: { id: eventId }, select: { id: true } })) throw new AppError(404, "Event not found");
    return db.$queryRaw<{ id: string; eventId: string; number: number; status: string }[]>`
      SELECT s.id,s.event_id AS "eventId",s.number,
       CASE WHEN EXISTS(SELECT 1 FROM bookings b WHERE b.seat_id=s.id AND b.status='CONFIRMED') THEN 'BOOKED'
       WHEN EXISTS(SELECT 1 FROM reservations r WHERE r.seat_id=s.id AND r.status='HELD' AND r.expires_at > clock_timestamp()) THEN 'HELD'
       WHEN EXISTS(SELECT 1 FROM reservations r WHERE r.seat_id=s.id AND r.status='HELD') THEN 'EXPIRED_PENDING_RELEASE'
       ELSE 'AVAILABLE' END AS status
      FROM seats s WHERE s.event_id=${eventId} ORDER BY s.number
    `;
  },

  expireBatch: async (limit = 100, shouldStop = () => false) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid expiry batch size");
    const candidates = await db.$queryRaw<{ id: string; event_id: string }[]>`
      SELECT id,event_id FROM reservations WHERE status='HELD' AND expires_at <= clock_timestamp()
      ORDER BY expires_at,id LIMIT ${limit}
    `;
    let expired = 0;
    for (const candidate of candidates) {
      if (shouldStop()) break;
      const result = await withBookingTransaction(async (tx) => {
        await lockEvent(tx, candidate.event_id);
        await lockReservation(tx, candidate.id);
        const changed = await expireReservation(tx, candidate.id);
        return { changed, reservation: await tx.reservation.findUniqueOrThrow({ where: { id: candidate.id } }) };
      });
      expired += result.changed;
      await updateReservationCache(result.reservation);
    }
    return expired;
  },
};
