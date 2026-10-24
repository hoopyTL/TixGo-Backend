import { Request, Response } from "express";
import { EventService } from "../services/event.service";
import { CreateEventInput } from "../validators/event.validator";
import { AppError } from "../errors/AppError";
import { parseCatalogQuery, parseResourceId, UpdateEventInput } from "../validators/resource.validator";

export const EventController = {
  getAllEvents: async (req: Request, res: Response) => {
    try {
      const result = await EventService.getAllEvents(parseCatalogQuery(req.query));
      if (result.nextCursor) res.setHeader("X-Next-Cursor", result.nextCursor);
      res.status(200).json(result.events);
    } catch (error) {
      if (error instanceof AppError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Lỗi Controller getAllEvents", error);
      res.status(500).json({ error: "Không thể lấy danh sách sự kiện" });
    }
  },

  updateEvent: async (req: Request, res: Response) => {
    try {
      const eventId = parseResourceId(req.params.id);
      const result = await EventService.updateEvent(req.user!.userId, eventId, req.body as UpdateEventInput);
      res.status(200).json({ message: "Event updated", data: result });
    } catch (error) {
      if (error instanceof AppError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Event update failed", error);
      res.status(500).json({ error: "Unable to update event" });
    }
  },

  createEvent: async (req: Request, res: Response) => {
    try {
      const eventData = req.body as CreateEventInput;
      const result = await EventService.createEvent(req.user!.userId, eventData);
      res
        .status(201)
        .json({ message: "Tạo sự kiện mới thành công", data: result });
    } catch (error) {
      if (error instanceof AppError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Lỗi Controller createEvent", error);
      res.status(500).json({ error: "Không thể tạo sự kiện mới" });
    }
  },
};
