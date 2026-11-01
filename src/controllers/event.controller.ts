import { Request, Response } from "express";
import { EventService } from "../services/event.service";
import { CreateEventInput } from "../validators/event.validator";
import { parseCatalogQuery, parseResourceId, UpdateEventInput } from "../validators/resource.validator";
import { sendSuccess } from "../utils/response";

export const EventController = {
  getAllEvents: async (req: Request, res: Response) => {
    const result = await EventService.getAllEvents(parseCatalogQuery(req.query));
    if (result.nextCursor) res.setHeader("X-Next-Cursor", result.nextCursor);
    sendSuccess(res, {
      statusCode: 200, message: "Events retrieved", code: "EVENTS_RETRIEVED", data: result.events,
      meta: { nextCursor: result.nextCursor ?? null },
    });
  },

  updateEvent: async (req: Request, res: Response) => {
    const eventId = parseResourceId(req.params.id);
    const result = await EventService.updateEvent(req.user!.userId, eventId, req.body as UpdateEventInput);
    sendSuccess(res, { statusCode: 200, message: "Event updated", code: "EVENT_UPDATED", data: result });
  },

  createEvent: async (req: Request, res: Response) => {
    const eventData = req.body as CreateEventInput;
    const result = await EventService.createEvent(req.user!.userId, eventData);
    sendSuccess(res, { statusCode: 201, message: "Event created", code: "EVENT_CREATED", data: result });
  },
};
