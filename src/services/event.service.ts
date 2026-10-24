import { Prisma } from "@prisma/client";
import { db } from "../configs/db";
import { AppError } from "../errors/AppError";
import { CreateEventInput } from "../validators/event.validator";
import { CatalogQuery, UpdateEventInput } from "../validators/resource.validator";
import { encodeCatalogCursor } from "../utils/catalog-cursor";
import { formatPrice } from "../utils/money";
import { lockCurrentActor } from "./access.service";

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
  getAllEvents: async ({ limit = 50, cursor }: CatalogQuery = { limit: 50, cursor: undefined }) => {
    const cursorFilter = cursor
      ? Prisma.sql`WHERE (created_at, id) < (${cursor.createdAt}, ${cursor.id})`
      : Prisma.empty;
    const events = await db.$queryRaw<Prisma.EventGetPayload<{ select: typeof publicEventSelect }>[]>`
      SELECT id, title, description, location,
             total_tickets AS "totalTickets", remain_tickets AS "remainTickets",
             price, created_at AS "createdAt"
      FROM events ${cursorFilter}
      ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}
    `;
    const visible = events.slice(0, limit);
    const last = visible[visible.length - 1];
    return {
      events: visible.map((event) => ({ ...event, price: formatPrice(event.price) })),
      nextCursor: events.length > limit && last ? encodeCatalogCursor(last) : undefined,
    };
  },

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
      return { ...event, price: formatPrice(event.price) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  },

  updateEvent: async (actorId: string, eventId: string, data: UpdateEventInput) => {
    return db.$transaction(async (tx) => {
      const actor = await lockCurrentActor(tx, actorId);
      if (actor.role !== "organizer" && actor.role !== "admin") {
        throw new AppError(403, "Only organizers and admins can update events");
      }
      const [event] = await tx.$queryRaw<{ id: string; organizer_id: string | null }[]>`
        SELECT id, organizer_id FROM events WHERE id = ${eventId} FOR UPDATE
      `;
      if (!event || (actor.role !== "admin" && event.organizer_id !== actor.id)) {
        throw new AppError(404, "Event not found");
      }
      const updated = await tx.event.update({
        where: { id: event.id },
        data: { title: data.title, description: data.description, location: data.location, price: data.price },
        select: { ...publicEventSelect, organizerId: true },
      });
      return { ...updated, price: formatPrice(updated.price) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  },
};
