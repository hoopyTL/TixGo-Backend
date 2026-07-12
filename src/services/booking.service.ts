import { db } from "../configs/db";
import { AppError } from "../errors/AppError";
import { generateRequestHash } from "../utils/hash";

export const BookingService = {
  createBooking: async (userId: string, eventId: string, idempotencyKey?: string) => {
    if (!idempotencyKey) {
      throw new AppError(400, "Missing idempotency key");
    }

    const requestHash = generateRequestHash(userId, { eventId });

    // 1. Chạy Prisma transaction toàn bộ để lock hàng đợi và key
    return db.$transaction(async (tx) => {
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
