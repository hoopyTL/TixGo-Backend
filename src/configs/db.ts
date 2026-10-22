import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const connectionUrl = new URL(databaseUrl);
const schema = connectionUrl.searchParams.get("schema") || "public";
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
  throw new Error("DATABASE_URL schema must be a SQL identifier");
}

const existingOptions = connectionUrl.searchParams.get("options") || "";
connectionUrl.searchParams.set("options", `${existingOptions} -c search_path="${schema}"`.trim());

const adapter = new PrismaPg({ connectionString: connectionUrl.toString() }, { schema });

export const db =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
