import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";
import serverOnly from "./eslint-rules/server-only.mjs";

// Next 16 removed the `next lint` command, so ESLint runs through its own CLI
// against this flat config. `core-web-vitals` already includes the base Next
// config; `typescript` layers typescript-eslint's recommended rules on top.
const config = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      // The codebase already marks deliberately-unused bindings with a leading
      // underscore (destructured props that exist only to be dropped from a
      // spread, for instance). Teach the rule that convention rather than
      // leaving warnings that `--max-warnings 0` would fail on.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Scoped to the application's own sources, because the invariant is about
    // what can reach a browser. `e2e/` runs in Node against a server that is
    // already built and signs a webhook with `process.env["NEXTAUTH_SECRET"]`
    // from outside the application entirely; `scripts/` is build tooling. A rule
    // that covered those would be asking them to import a module marked
    // `server-only`, which is the opposite of the point.
    //
    // Test files under `src/` are in scope deliberately: `vi.stubEnv` is how a
    // test sets a variable, and a test that reads a secret out of `process.env`
    // instead is reading the machine it happens to run on.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    plugins: { "server-only": serverOnly },
    rules: {
      // Errors rather than warns: `--max-warnings 0` makes the two equivalent in
      // CI, and an editor should underline this one in red.
      "server-only/no-secret-env-access": "error",
    },
  },
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
];

export default config;
