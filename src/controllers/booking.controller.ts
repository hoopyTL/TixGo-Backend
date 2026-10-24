import { Request, Response } from "express";
import { BookingService } from "../services/booking.service";
import { AppError } from "../errors/AppError";
import { parseResourceId } from "../validators/resource.validator";

export const BookingController = {
  getBooking: async (req: Request, res: Response) => {
    try {
      const result = await BookingService.getBooking(req.user!.userId, parseResourceId(req.params.id));
      res.status(200).json({ data: result });
    } catch (error) {
      if (error instanceof AppError) return res.status(error.statusCode).json({ error: error.message });
      console.error("Booking read failed", error);
      res.status(500).json({ error: "Unable to read booking" });
    }
  },

  cancelBooking: async (req: Request, res: Response) => {
    try {
      const result = await BookingService.cancelBooking(req.user!.userId, parseResourceId(req.params.id));
      res.status(200).json({ message: "Booking cancelled", data: result });
    } catch (error) {
      if (error instanceof AppError) return res.status(error.statusCode).json({ error: error.message });
      console.error("Booking cancellation failed", error);
      res.status(500).json({ error: "Unable to cancel booking" });
    }
  },
  createBooking: async (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const { eventId } = req.body;
      const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

      const { data, cached } = await BookingService.createBooking(userId, eventId, idempotencyKey);

      if (cached) {
        // Request trùng lặp: trả về kết quả cũ, 200 thay vì 201
        // Header Idempotent-Replayed giúp client/debug biết đây là cached response
        res.setHeader("Idempotent-Replayed", "true");
        return res.status(200).json({ message: "Đặt vé thành công", data });
      }

      res.status(201).json({ message: "Đặt vé thành công", data });
    } catch (error) {
      if (error instanceof AppError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Lỗi Controller createBooking", error);
      return res.status(500).json({ error: "Không thể thực hiện đặt vé" });
    }
  },
};
