import { Request, Response } from "express";
import { BookingService } from "../services/booking.service";
import { parseIdempotencyKey } from "../validators/booking.validator";
import { parseResourceId } from "../validators/resource.validator";

export const BookingController = {
  getBooking: async (req: Request, res: Response) => {
    const result = await BookingService.getBooking(req.user!.userId, parseResourceId(req.params.id));
    res.status(200).json({ data: result });
  },

  cancelBooking: async (req: Request, res: Response) => {
    const result = await BookingService.cancelBooking(req.user!.userId, parseResourceId(req.params.id));
    res.status(200).json({ message: "Booking cancelled", data: result });
  },
  createBooking: async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const idempotencyKey = parseIdempotencyKey(req.headers["idempotency-key"]);

    const { data, cached } = await BookingService.createBooking(userId, req.body, idempotencyKey);

    if (cached) {
      res.setHeader("Idempotent-Replayed", "true");
      return res.status(200).json({ message: "Đặt vé thành công", data });
    }

    res.status(201).json({ message: "Đặt vé thành công", data });
  },
};
