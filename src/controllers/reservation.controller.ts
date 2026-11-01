import { Request, Response } from "express";
import { ReservationService } from "../services/reservation.service";
import { parseResourceId } from "../validators/resource.validator";
import { sendSuccess } from "../utils/response";

export const ReservationController = {
  hold: async (req: Request, res: Response) => {
    const result = await ReservationService.hold(req.user!.userId, req.body);
    sendSuccess(res, {
      statusCode: result.cached ? 200 : 201, message: "Reservation held", code: "RESERVATION_HELD", data: result.data,
      meta: { serverTime: new Date().toISOString() },
    });
  },
  get: async (req: Request, res: Response) => {
    const data = await ReservationService.get(req.user!.userId, parseResourceId(req.params.id));
    sendSuccess(res, { statusCode: 200, message: "Reservation retrieved", code: "RESERVATION_RETRIEVED", data });
  },
  release: async (req: Request, res: Response) => {
    await ReservationService.release(req.user!.userId, parseResourceId(req.params.id));
    res.status(204).end();
  },
  seats: async (req: Request, res: Response) => {
    const data = await ReservationService.listSeats(parseResourceId(req.params.id));
    sendSuccess(res, { statusCode: 200, message: "Seats retrieved", code: "SEATS_RETRIEVED", data });
  },
};
