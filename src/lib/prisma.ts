import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { env } from "@/lib/env";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Prisma 7 dropped the engine-managed connection: the datasource URL no longer
// lives in schema.prisma, so the client is handed a driver adapter instead. The
// adapter owns the pg connection pool, which is why this module must stay the
// only place a PrismaClient is constructed.
function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

  return new PrismaClient({
    adapter,
    log:
      env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// The dev server re-evaluates modules on every hot reload; without this the pool
// would be recreated until Postgres refuses new connections.
if (env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
