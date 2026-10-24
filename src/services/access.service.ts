import { Prisma } from "@prisma/client";
import { AppError } from "../errors/AppError";

export async function lockCurrentActor(tx: Prisma.TransactionClient, actorId: string) {
  const [actor] = await tx.$queryRaw<{ id: string; role: string }[]>`
    SELECT id, role FROM users WHERE id = ${actorId} FOR SHARE
  `;
  if (!actor) throw new AppError(401, "Authenticated account no longer exists");
  if (!["buyer", "organizer", "admin"].includes(actor.role)) {
    throw new AppError(403, "Account role is not allowed");
  }
  return actor;
}
