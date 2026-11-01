import { Request, Response } from "express";
import { BookingService } from "../services/booking.service";
import { parseIdempotencyKey } from "../validators/booking.validator";
import { parseResourceId } from "../validators/resource.validator";
import { sendSuccess } from "../utils/response";

export const BookingController = {
  getBooking: async (req: Request, res: Response) => {
    const result = await BookingService.getBooking(req.user!.userId, parseResourceId(req.params.id));
    sendSuccess(res, { statusCode: 200, message: "Booking retrieved", code: "BOOKING_RETRIEVED", data: result });
  },

  cancelBooking: async (req: Request, res: Response) => {
    const result = await BookingService.cancelBooking(req.user!.userId, parseResourceId(req.params.id));
    sendSuccess(res, { statusCode: 200, message: "Booking cancelled", code: "BOOKING_CANCELLED", data: result });
  },
  createBooking: async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const idempotencyKey = parseIdempotencyKey(req.headers["idempotency-key"]);

    const { data, cached } = await BookingService.createBooking(userId, req.body, idempotencyKey);

    if (cached) {
      res.setHeader("Idempotent-Replayed", "true");
    }

    sendSuccess(res, {
      statusCode: cached ? 200 : 201, message: "Booking confirmed", code: "BOOKING_CONFIRMED", data,
    });
  },
};
