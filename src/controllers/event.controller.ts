import { Request, Response } from "express";
import { EventService } from "../services/event.service";
import { CreateEventInput } from "../validators/event.validator";

export const EventController = {
  getAllEvents: async (req: Request, res: Response) => {
    try {
      const allEvents = await EventService.getAllEvents();
      res.status(200).json(allEvents);
    } catch (error) {
      console.error("Lỗi Controller getAllEvents", error);
      res.status(500).json({ error: "Không thể lấy danh sách sự kiện" });
    }
  },

  createEvent: async (req: Request, res: Response) => {
    try {
      const eventData = req.body as CreateEventInput;
      const result = await EventService.createEvent(eventData);
      res
        .status(201)
        .json({ message: "Tạo sự kiện mới thành công", data: result });
    } catch (error) {
      console.error("Lỗi Controller createEvent", error);
      res.status(500).json({ error: "Không thể tạo sự kiện mới" });
    }
  },
};
