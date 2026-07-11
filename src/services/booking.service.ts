import { db } from "../configs/db";
import { AppError } from "../errors/AppError";

export const BookingService = {
  createBooking: async (userId: string, eventId: string) => {
    // 1. Chạy Prisma Transaction toàn bộ để lock hàng đợi
    return db.$transaction(async (tx) => {
      // 2. Lấy lock độc quyền trên hàng Event (Pessimistic Lock)
      const events = await tx.$queryRaw<any[]>`
        SELECT * FROM events WHERE id = ${eventId} FOR UPDATE
      `;

      const event = events[0];

      // 3. Nếu không tìm thấy event -> quăng lỗi 404
      if (!event) {
        throw new AppError(404, "Không tìm thấy Event");
      }

      // 4. Nếu remain_tickets <= 0 -> quăng lỗi 409 (Conflict)
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

      // 7. Trả về thông tin booking vừa tạo
      return booking;
    });
  },
};
