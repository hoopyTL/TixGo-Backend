import { Request, Response } from "express";
import { ReservationService } from "../services/reservation.service";
import { parseResourceId } from "../validators/resource.validator";
import { AppError } from "../errors/AppError";

export function bookingError(res: Response, error: unknown) {
  if (error instanceof AppError) {
    if (error.statusCode === 503) res.setHeader("Retry-After", "1");
    return res.status(error.statusCode).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  console.error("Booking operation failed", error);
  return res.status(500).json({ error: "Unable to complete booking operation" });
}

export const ReservationController = {
  hold: async (req: Request, res: Response) => {
    try {
      const result = await ReservationService.hold(req.user!.userId, req.body);
      res.status(result.cached ? 200 : 201).json({ data: result.data, serverTime: new Date().toISOString() });
    } catch (error) { bookingError(res, error); }
  },
  get: async (req: Request, res: Response) => {
    try { res.json({ data: await ReservationService.get(req.user!.userId, parseResourceId(req.params.id)) }); }
    catch (error) { bookingError(res, error); }
  },
  release: async (req: Request, res: Response) => {
    try {
      await ReservationService.release(req.user!.userId, parseResourceId(req.params.id));
      res.status(204).end();
    } catch (error) { bookingError(res, error); }
  },
  seats: async (req: Request, res: Response) => {
    try { res.json({ data: await ReservationService.listSeats(parseResourceId(req.params.id)) }); }
    catch (error) { bookingError(res, error); }
  },
};
