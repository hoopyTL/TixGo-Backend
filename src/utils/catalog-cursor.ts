import { Buffer } from "node:buffer";
import { z } from "zod";
import { AppError } from "../errors/AppError";

export type CatalogCursor = { createdAt: Date; id: string };

const CursorSchema = z.object({
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  id: z.string().uuid(),
}).strict();

export function encodeCatalogCursor(value: CatalogCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: value.createdAt.toISOString(), id: value.id })).toString("base64url");
}

export function decodeCatalogCursor(value: string): CatalogCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 512) throw new Error();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    const parsed = CursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    const createdAt = new Date(parsed.createdAt);
    if (createdAt.toISOString() !== parsed.createdAt) throw new Error();
    return { createdAt, id: parsed.id };
  } catch {
    throw new AppError(400, "Invalid catalog cursor");
  }
}
