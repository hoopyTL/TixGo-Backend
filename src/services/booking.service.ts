import { Prisma } from "@prisma/client";
import { db } from "../configs/db";
import { AppError } from "../errors/AppError";
import { generateRequestHash } from "../utils/hash";
import { lockCurrentActor } from "./access.service";

const bookingSelect = {
  id: true, userId: true, eventId: true, status: true, createdAt: true,
} satisfies Prisma.BookingSelect;

export const BookingService = {
  getBooking: async (actorId: string, bookingId: string) => {
    return db.$transaction(async (tx) => {
      const actor = await lockCurrentActor(tx, actorId);
      const booking = await tx.booking.findFirst({
        where: { id: bookingId, ...(actor.role === "admin" ? {} : { userId: actor.id }) },
        select: bookingSelect,
      });
      if (!booking) throw new AppError(404, "Booking not found");
      return booking;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  },

  cancelBooking: async (actorId: string, bookingId: string) => {
    return db.$transaction(async (tx) => {
      const actor = await lockCurrentActor(tx, actorId);
      const target = await tx.booking.findFirst({
        where: { id: bookingId, ...(actor.role === "admin" ? {} : { userId: actor.id }) },
        select: { eventId: true },
      });
      if (!target) throw new AppError(404, "Booking not found");

      // Use the same Event-first order as booking creation before locking a booking.
      const [event] = await tx.$queryRaw<{ id: string; total_tickets: number; remain_tickets: number }[]>`
        SELECT id, total_tickets, remain_tickets FROM events WHERE id = ${target.eventId} FOR UPDATE
      `;
      const [booking] = await tx.$queryRaw<{ id: string; user_id: string; event_id: string; status: string }[]>`
        SELECT id, user_id, event_id, status FROM bookings WHERE id = ${bookingId} FOR UPDATE
      `;
      if (!booking || (actor.role !== "admin" && booking.user_id !== actor.id)) {
        throw new AppError(404, "Booking not found");
      }
      if (!event || booking.event_id !== event.id) {
        throw new AppError(409, "Booking changed during cancellation");
      }
      if (booking.status === "CANCELLED") {
        return tx.booking.findUniqueOrThrow({ where: { id: booking.id }, select: bookingSelect });
      }
      if (booking.status !== "CONFIRMED") throw new AppError(409, "Booking cannot be cancelled");
      if (event.remain_tickets < 0 || event.remain_tickets >= event.total_tickets) {
        throw new AppError(409, "Inventory cannot be restored within event capacity");
      }
      const cancelled = await tx.booking.update({
        where: { id: booking.id }, data: { status: "CANCELLED" }, select: bookingSelect,
      });
      await tx.event.update({ where: { id: event.id }, data: { remainTickets: { increment: 1 } } });
      return cancelled;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  },
  createBooking: async (userId: string, eventId: string, idempotencyKey?: string) => {
    if (!idempotencyKey) {
      throw new AppError(400, "Missing idempotency key");
    }

    const requestHash = generateRequestHash(userId, { eventId });

    // 1. Chạy Prisma transaction toàn bộ để lock hàng đợi và key
    return db.$transaction(async (tx) => {
      // Lock order: current user, request key, Event, then Booking.
      await lockCurrentActor(tx, userId);
      // Serialize retries before checking the key; the lock is released on commit/rollback.
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${JSON.stringify([userId, idempotencyKey])}, 0)
        )::text
      `;

      const existingKey = await tx.idempotency.findUnique({
        where: {
          userId_key: { userId, key: idempotencyKey },
        },
      });

      if (existingKey) {
        // Chặn payload mismatch: cùng key nhưng body khác
        if (existingKey.requestHash !== requestHash) {
          throw new AppError(400, "Request hash mismatch");
        }

        if (existingKey.status === "COMPLETED") {
          // Trả về kết quả đã cache, đánh dấu cached: true để controller xử lý khác
          return { data: JSON.parse(existingKey.responseBody!), cached: true };
        }

        throw new AppError(409, "Request is processing");
      }

      // Tạo bản ghi idempotency tạm thời với status PROCESSING
      await tx.idempotency.create({
        data: {
          userId,
          key: idempotencyKey,
          requestHash,
          status: "PROCESSING",
        },
      });

      // 2. Lấy lock độc quyền trên hàng Event (Pessimistic Lock)
      const events = await tx.$queryRaw<any[]>`
        SELECT * FROM events WHERE id = ${eventId} FOR UPDATE
      `;

      const event = events[0];

      // 3. Nếu không tìm thấy event -> quăng lỗi 404
      if (!event) {
        throw new AppError(404, "Không tìm thấy Event");
      }

      // 4. Nếu remainTickets <= 0 -> quăng lỗi 409 (Conflict)
      if (event.remain_tickets <= 0) {
        throw new AppError(409, "Sự kiện đã hết vé");
      }

      // 5. Tạo bản ghi Booking mới (mặc định status CONFIRMED)
      const booking = await tx.booking.create({
        data: {
          userId,
          eventId,
        },
      });

      // 6. Update giảm remainTickets của Event đi 1
      await tx.event.update({
        where: { id: eventId },
        data: { remainTickets: { decrement: 1 } },
      });

      // 7. Cập nhật trạng thái Idempotency sang COMPLETED và lưu lại kết quả
      await tx.idempotency.update({
        where: {
          userId_key: { userId, key: idempotencyKey },
        },
        data: {
          status: "COMPLETED",
          responseStatus: 201,
          responseBody: JSON.stringify(booking),
        },
      });

      // Trả về kết quả mới tạo, cached: false
      return { data: booking, cached: false };
    });
  },
};
