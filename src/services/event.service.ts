import { Prisma } from "@prisma/client";
import { db } from "../configs/db";
import { AppError } from "../errors/AppError";
import { CreateEventInput } from "../validators/event.validator";

// Keep account identifiers and future private fields out of the public catalog.
const publicEventSelect = {
  id: true,
  title: true,
  description: true,
  location: true,
  totalTickets: true,
  remainTickets: true,
  price: true,
  createdAt: true,
} satisfies Prisma.EventSelect;

export const EventService = {
  getAllEvents: async () => db.event.findMany({ select: publicEventSelect }),

  createEvent: async (actorId: string, data: CreateEventInput) => {
    return db.$transaction(async (tx) => {
      const userIds = [...new Set([actorId, ...(data.organizerId ? [data.organizerId] : [])])];
      // SHARE conflicts with role updates and deletion, while allowing concurrent creates.
      // Ordered locks stabilize both roles until commit and avoid opposite lock order.
      const users = await tx.$queryRaw<{ id: string; role: string }[]>`
        SELECT id, role FROM users
        WHERE id IN (${Prisma.join(userIds)})
        ORDER BY id FOR SHARE
      `;
      const actor = users.find((user) => user.id === actorId);
      if (!actor) throw new AppError(401, "Authenticated account no longer exists");
      if (actor.role !== "organizer" && actor.role !== "admin") {
        throw new AppError(403, "Only organizers and admins can create events");
      }

      let organizerId: string;
      if (actor.role === "organizer") {
        if (data.organizerId !== undefined) {
          throw new AppError(400, "Organizers cannot specify an owner");
        }
        organizerId = actor.id;
      } else {
        const recipient = users.find((user) => user.id === data.organizerId);
        if (!recipient || recipient.role !== "organizer") {
          throw new AppError(400, "Admin must specify an existing organizer in organizerId");
        }
        organizerId = recipient.id;
      }
      // Authorization point: all required user rows are locked and roles checked.
      const event = await tx.event.create({
        data: {
          title: data.title,
          description: data.description,
          location: data.location,
          price: data.price,
          totalTickets: data.totalTickets,
          remainTickets: data.totalTickets,
          organizerId,
        },
        select: { ...publicEventSelect, organizerId: true },
      });
      return event;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  },
};
