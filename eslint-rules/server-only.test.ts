import path from "node:path";
import { RuleTester } from "eslint";
import { describe, expect, it } from "vitest";
import plugin, { ENV_MODULE } from "./server-only.mjs";

/**
 * The rule, exercised through ESLint's own tester.
 *
 * `RuleTester` picks up the ambient `describe`/`it`, so each case below becomes a
 * test of its own. The rule reads `SECRET_KEYS` out of the real
 * `src/lib/env/server.ts` — that is the point of it, one list — so these cases
 * use real secret names and would start failing if one were renamed without the
 * list following, which is the same thing `scripts/assert-server-only.ts`
 * checks from the other side.
 */
const rule = plugin.rules["no-secret-env-access"];

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

ruleTester.run("no-secret-env-access", rule, {
  valid: [
    { code: "const url = serverEnv.DATABASE_URL;" },
    // Public by construction: Next substitutes these into the client bundle on
    // purpose, so a rule against reading one would fail the code that must.
    { code: 'const app = process.env["NEXT_PUBLIC_APP_URL"];' },
    // Server configuration that is not key material. The line this rule draws is
    // "a credential", not "a variable".
    { code: "const mode = process.env.NODE_ENV;" },
    { code: 'const origin = process.env["AUTH_URL"];' },
    // A computed key is not something this rule can resolve, and guessing would
    // mean either false positives on a lookup table or a false sense of cover.
    { code: "const v = process.env[name];" },
    // The env module is where the reads are supposed to happen.
    {
      code: "const secret = process.env.NEXTAUTH_SECRET;",
      filename: path.join(process.cwd(), ENV_MODULE),
    },
    // `process` shadowed by something else entirely.
    {
      code: "function f(process) { return process.env.NEXTAUTH_SECRET; }",
    },
  ],
  invalid: [
    {
      code: "const secret = process.env.NEXTAUTH_SECRET;",
      errors: [{ messageId: "rawRead" }],
    },
    {
      code: 'const url = process.env["DATABASE_URL"];',
      errors: [{ messageId: "rawRead" }],
    },
    {
      // The shape someone reaches for when the member access starts failing lint.
      code: "const { PREVIEW_SECRET } = process.env;",
      errors: [{ messageId: "rawRead" }],
    },
    {
      code: "const { AWS_SECRET_ACCESS_KEY: key } = process.env;",
      errors: [{ messageId: "rawRead" }],
    },
    {
      code: "const a = process.env.NEXTAUTH_SECRET; const b = process.env.REVALIDATE_SECRET;",
      errors: [{ messageId: "rawRead" }, { messageId: "rawRead" }],
    },
    {
      // An imported `process` is the same object under the same name, so this is
      // not the shadow the valid case above describes — a rule that skipped it
      // would be one import away from being switched off.
      code: 'import process from "node:process";\nconst s = process.env.NEXTAUTH_SECRET;',
      errors: [{ messageId: "rawRead" }],
    },
  ],
});

describe("the rule's own wiring", () => {
  it("names the key in the message, since the fix is per-variable", () => {
    expect(rule.meta?.messages?.["rawRead"]).toContain("{{key}}");
  });

  it("is reported as a problem rather than a suggestion", () => {
    // `--max-warnings 0` makes severity moot in CI, but an editor decides
    // whether to underline in red from this.
    expect(rule.meta?.type).toBe("problem");
  });
});
