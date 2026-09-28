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
    // One writer, enforced where it is cheapest to enforce: in the editor.
    //
    // Redaction can only apply to lines that go through
    // `src/lib/logging/redact.ts`, and before this item there were twenty-odd
    // `console.*` calls across the action wrapper, the route wrapper, the
    // idempotency runner, the outbox, the upload path and two env modules,
    // several of them handing Node a thrown value to format at its own
    // discretion. A redactor with a bypass that short is a redactor with no
    // coverage.
    //
    // This rule is the first of two layers and catches the typing of it;
    // `scripts/assert-log-redaction.ts` is the second and catches the rest —
    // an `eslint-disable` comment, a rule removed from this file, a `globalThis
    // .console` spelling. Neither layer sees what the other does.
    //
    // Test files are out of scope: spying on the console is how a test asserts
    // that nothing was written to it.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // The writer itself, and the two client-side exceptions.
    //
    // `src/lib/logging/logger.ts` is where the ban has to end: something has to
    // call `console`.
    //
    // The others run only in a browser, where "the log" is the console of the
    // person who caused the error and not a stream anyone collects — the thing
    // redaction exists to keep a secret out of. Routing them through the
    // serialiser would put it, and its pattern table, into the client bundle to
    // protect a value that is already in that browser's memory.
    // `src/lib/env/client.ts` has a second reason that is stronger than the
    // first: the only thing it can print is the validation failure of a
    // `NEXT_PUBLIC_*` variable, and a schema containing no secrets is the whole
    // purpose of the server/client env split. Both are held to this list by
    // rule R2 of `scripts/assert-log-redaction.ts`.
    files: [
      "src/lib/logging/logger.ts",
      "src/lib/env/client.ts",
      "src/app/**/error.tsx",
    ],
    rules: {
      "no-console": "off",
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
