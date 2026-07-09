import { db } from "../configs/db";
import { AppError } from "../errors/AppError";

export const BookingService = {
  createBooking: async (userId: string, eventId: string) => {
    // 1: Query tìm event trước để kiểm tra sự tồn tại & số vé còn lại
    const event = await db.event.findUnique({ where: { id: eventId } });

    // 2. Nếu không tìm thấy event -> quăng lỗi 404
    if (!event) {
      throw new AppError(404, "Không tìm thấy Event");
    }

    // 3. Nếu event.remainTickets <= 0 -> quăng lỗi 409 (Conflict)
    if (event.remainTickets <= 0) {
      throw new AppError(409, "Sự kiện đã hết vé");
    }

    // 4: Chạy Prisma Transaction
    return db.$transaction(async (tx) => {
      // 4a. Tạo bản ghi Booking mới (mặc định status CONFIRMED)
      const booking = await tx.booking.create({
        data: {
          userId,
          eventId,
        },
      });

      // 4b. Update giảm remainTickets của Event đi 1
      await tx.event.update({
        where: { id: eventId },
        data: { remainTickets: { decrement: 1 } },
      });

      // 4c. Trả về thông tin booking vừa tạo
      return booking;
    });
  },
};
