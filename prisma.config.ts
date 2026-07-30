import { defineConfig, env } from "prisma/config";

// Prisma 7 moved connection URLs out of schema.prisma. Migrate and introspect
// read them from here; the runtime client gets its connection from the driver
// adapter in `src/lib/prisma.ts` instead.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
