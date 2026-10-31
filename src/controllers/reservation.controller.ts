import { Request, Response } from "express";
import { ReservationService } from "../services/reservation.service";
import { parseResourceId } from "../validators/resource.validator";

export const ReservationController = {
  hold: async (req: Request, res: Response) => {
    const result = await ReservationService.hold(req.user!.userId, req.body);
    res.status(result.cached ? 200 : 201).json({ data: result.data, serverTime: new Date().toISOString() });
  },
  get: async (req: Request, res: Response) => {
    res.json({ data: await ReservationService.get(req.user!.userId, parseResourceId(req.params.id)) });
  },
  release: async (req: Request, res: Response) => {
    await ReservationService.release(req.user!.userId, parseResourceId(req.params.id));
    res.status(204).end();
  },
  seats: async (req: Request, res: Response) => {
    res.json({ data: await ReservationService.listSeats(parseResourceId(req.params.id)) });
  },
};
