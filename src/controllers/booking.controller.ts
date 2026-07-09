import { Request, Response } from "express";
import { BookingService } from "../services/booking.service";
import { AppError } from "../errors/AppError";

export const BookingController = {
  createBooking: async (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const { eventId } = req.body;

      const booking = await BookingService.createBooking(userId, eventId);

      res.status(201).json({ message: "Đặt vé thành công", data: booking });
    } catch (error) {
      if (error instanceof AppError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Lỗi Controller createBooking", error);
      return res.status(500).json({ error: "Không thể thực hiện đặt vé" });
    }
  },
};
