import { Request, Response } from "express";
import { EventService } from "../services/event.service";
import { CreateEventInput } from "../validators/event.validator";
import { parseCatalogQuery, parseResourceId, UpdateEventInput } from "../validators/resource.validator";

export const EventController = {
  getAllEvents: async (req: Request, res: Response) => {
    const result = await EventService.getAllEvents(parseCatalogQuery(req.query));
    if (result.nextCursor) res.setHeader("X-Next-Cursor", result.nextCursor);
    res.status(200).json(result.events);
  },

  updateEvent: async (req: Request, res: Response) => {
    const eventId = parseResourceId(req.params.id);
    const result = await EventService.updateEvent(req.user!.userId, eventId, req.body as UpdateEventInput);
    res.status(200).json({ message: "Event updated", data: result });
  },

  createEvent: async (req: Request, res: Response) => {
    const eventData = req.body as CreateEventInput;
    const result = await EventService.createEvent(req.user!.userId, eventData);
    res
      .status(201)
      .json({ message: "Tạo sự kiện mới thành công", data: result });
  },
};
