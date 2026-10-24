import { z } from "zod";
import { AppError } from "../errors/AppError";
import { decodeCatalogCursor } from "../utils/catalog-cursor";

const CatalogQuerySchema = z.object({
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number)
    .pipe(z.number().int().min(1).max(100)).optional().default(50),
  cursor: z.string().min(1).max(512).optional(),
}).strict();

export function parseCatalogQuery(value: unknown) {
  const result = CatalogQuerySchema.safeParse(value);
  if (!result.success) throw new AppError(400, "Invalid catalog query");
  return { limit: result.data.limit, cursor: result.data.cursor ? decodeCatalogCursor(result.data.cursor) : undefined };
}

export type CatalogQuery = ReturnType<typeof parseCatalogQuery>;
