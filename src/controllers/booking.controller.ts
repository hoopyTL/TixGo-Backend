import { Request, Response } from "express";
import { BookingService } from "../services/booking.service";
import { bookingError } from "./reservation.controller";
import { parseIdempotencyKey } from "../validators/booking.validator";
import { parseResourceId } from "../validators/resource.validator";

export const BookingController = {
  getBooking: async (req: Request, res: Response) => {
    try {
      const result = await BookingService.getBooking(req.user!.userId, parseResourceId(req.params.id));
      res.status(200).json({ data: result });
    } catch (error) {
      bookingError(res, error);
    }
  },

  cancelBooking: async (req: Request, res: Response) => {
    try {
      const result = await BookingService.cancelBooking(req.user!.userId, parseResourceId(req.params.id));
      res.status(200).json({ message: "Booking cancelled", data: result });
    } catch (error) {
      bookingError(res, error);
    }
  },
  createBooking: async (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const idempotencyKey = parseIdempotencyKey(req.headers["idempotency-key"]);

      const { data, cached } = await BookingService.createBooking(userId, req.body, idempotencyKey);

      if (cached) {
        res.setHeader("Idempotent-Replayed", "true");
        return res.status(200).json({ message: "Đặt vé thành công", data });
      }

      res.status(201).json({ message: "Đặt vé thành công", data });
    } catch (error) {
      bookingError(res, error);
    }
  },
};
