import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
};

// `e2e/` holds Playwright specs, which use a different `test` runtime and
// throw if Vitest collects them. `pnpm test:e2e` owns that directory.
const exclude = ["node_modules/**", "dist/**", ".next/**", "e2e/**"];

export default defineConfig({
  test: {
    // Two environments, split by extension: `.test.tsx` renders components and
    // needs a DOM, `.test.ts` exercises server-side modules and is faster
    // without one. This used to be `environmentMatchGlobs`, which Vitest 3
    // deprecated (and warns about on every run) in favour of projects.
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "dom",
          environment: "jsdom",
          globals: true,
          setupFiles: ["./src/test/setup.ts"],
          include: ["src/**/*.test.tsx"],
          exclude,
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "node",
          environment: "node",
          globals: true,
          setupFiles: ["./src/test/setup.ts"],
          // `scripts/` holds build tooling (the CI warning gate); it is plain
          // Node, so it belongs to this project rather than the DOM one.
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude,
        },
      },
    ],
    // Coverage is collected across both projects, so it stays at the root.
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [
        "node_modules/**",
        "src/test/**",
        "**/*.config.*",
        "prisma/**",
        ".next/**",
      ],
    },
  },
});
