import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  // `server-only` is a marker package: its only export map entry for the
  // `react-server` condition is an empty module, and its default entry *throws*
  // — which is how Next turns "this module reached a client bundle" into a build
  // error. Vitest resolves with neither condition set, so every test that
  // touches `@/lib/env/server`, `@/lib/prisma` or `@/auth` would fail at import
  // on the marker rather than on anything it is testing.
  //
  // Aliased to the package's own `empty.js` rather than to a stub of ours, so
  // this resolves to exactly the file the `react-server` condition would pick.
  // Setting `resolve.conditions: ["react-server"]` instead would do it for this
  // package and also hand every test React's server build, which has no
  // `useState` — the DOM project renders components, so that trade is not
  // available. `scripts/assert-server-only.ts` is what checks the boundary this
  // alias makes invisible to the unit suite.
  "server-only": fileURLToPath(
    new URL("./node_modules/server-only/empty.js", import.meta.url),
  ),
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
          // `scripts/` holds build tooling (the CI warning gate) and
          // `eslint-rules/` the local ESLint plugin; both are plain Node, so they
          // belong to this project rather than the DOM one.
          include: [
            "src/**/*.test.ts",
            "scripts/**/*.test.ts",
            "eslint-rules/**/*.test.ts",
          ],
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
