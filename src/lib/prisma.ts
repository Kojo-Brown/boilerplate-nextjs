// A Postgres URL carries its password in the authority, so this module is where
// the secret graph starts for every read and write in the application. Marked
// even though `@/lib/env/server` below is marked too: the point of the marker is
// that the failure names the module a person would look at, and "prisma is not
// importable from the browser" is the fact worth stating here. See
// docs/server-only.md.
import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { serverEnv } from "@/lib/env/server";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Prisma 7 dropped the engine-managed connection: the datasource URL no longer
// lives in schema.prisma, so the client is handed a driver adapter instead. The
// adapter owns the pg connection pool, which is why this module must stay the
// only place a PrismaClient is constructed.
function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: serverEnv.DATABASE_URL });

  return new PrismaClient({
    adapter,
    log:
      serverEnv.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// The dev server re-evaluates modules on every hot reload; without this the pool
// would be recreated until Postgres refuses new connections.
if (serverEnv.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
