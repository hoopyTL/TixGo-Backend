import { db } from "../configs/db";
import { CreateEventInput } from "../validators/event.validator";

export const EventService = {
    getAllEvents: async () => {
        return db.event.findMany();
    },

    createEvent: async (data: CreateEventInput) => {
        return db.event.create({ data });
    },
};