import { ForbiddenError, UnauthorizedError } from "../errors/http-errors";
import { Prisma } from "@prisma/client";

export async function lockCurrentActor(tx: Prisma.TransactionClient, actorId: string) {
  const [actor] = await tx.$queryRaw<{ id: string; role: string }[]>`
    SELECT id, role FROM users WHERE id = ${actorId} FOR SHARE
  `;
  if (!actor) throw new UnauthorizedError("Authenticated account no longer exists");
  if (!["buyer", "organizer", "admin"].includes(actor.role)) {
    throw new ForbiddenError("Account role is not allowed");
  }
  return actor;
}
