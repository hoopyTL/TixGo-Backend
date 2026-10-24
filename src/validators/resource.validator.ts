import { z } from "zod";
import { AppError } from "../errors/AppError";
import { PriceSchema } from "../utils/money";
import { decodeCatalogCursor } from "../utils/catalog-cursor";

export const UpdateEventSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  price: PriceSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Provide at least one event field");

export const CancelBookingSchema = z.object({}).strict().default({});

const ResourceIdSchema = z.string().uuid();
const CatalogQuerySchema = z.object({
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number)
    .pipe(z.number().int().min(1).max(100)).optional().default(50),
  cursor: z.string().min(1).max(512).optional(),
}).strict();

export function parseResourceId(value: unknown): string {
  const result = ResourceIdSchema.safeParse(value);
  if (!result.success) throw new AppError(400, "Invalid resource ID");
  return result.data;
}

export function parseCatalogQuery(value: unknown) {
  const result = CatalogQuerySchema.safeParse(value);
  if (!result.success) throw new AppError(400, "Invalid catalog query");
  return { limit: result.data.limit, cursor: result.data.cursor ? decodeCatalogCursor(result.data.cursor) : undefined };
}

export type UpdateEventInput = z.infer<typeof UpdateEventSchema>;
export type CatalogQuery = ReturnType<typeof parseCatalogQuery>;
