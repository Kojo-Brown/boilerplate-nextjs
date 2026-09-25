/**
 * The lint half of the server-only boundary: no application module reads a
 * secret out of `process.env` directly.
 *
 * `import "server-only"` is the other half and the stronger one — Next compiles
 * that marker to a module that throws when it lands in a client bundle, so a
 * client component that reaches `@/lib/env/server` at any depth fails the build.
 * What the marker cannot see is the read that imports nothing:
 *
 *     const key = process.env.NEXTAUTH_SECRET;   // in a client component
 *
 * There is no import to mark, so nothing fails. Next substitutes literals for
 * `NEXT_PUBLIC_*` names only, so in a browser that expression is `undefined`, and
 * the code carries on with an empty key: an HMAC over a zero-length secret, a
 * comparison against `undefined`, a `?? ""` fallback that silently disables a
 * check. Nothing throws, nothing logs, and nothing leaks either — which is why
 * it can sit there for months.
 *
 * On the server the same read is merely wrong in a quieter way: it bypasses the
 * Zod schema in `@/lib/env/server`, so a missing or malformed value becomes
 * `undefined` at the point of use instead of a refusal to boot. `src/auth.ts`
 * had exactly that — `process.env["GOOGLE_CLIENT_SECRET"] ?? ""` — which is an
 * OAuth client configured with an empty secret whenever the variable is absent.
 *
 * Which names count as secrets is not a judgement this rule makes. It reads the
 * `SECRET_KEYS` array out of `src/lib/env/server.ts`, next to the schema that
 * declares them, so there is one list. `scripts/assert-server-only.ts` reads the
 * same array and applies the same check as a gate, because an `eslint-disable`
 * comment is a one-line edit and this is not a rule anyone should be able to
 * turn off in passing. See docs/server-only.md.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** The module that owns the server schema, and the only legal place to read one. */
export const ENV_MODULE = "src/lib/env/server.ts";

/**
 * The secret names, parsed out of the env module's source.
 *
 * Deliberately textual. Importing the module would evaluate it — which means
 * validating the environment, and failing in any checkout without a `.env` — and
 * it is marked `server-only`, so importing it from a Node process is exactly the
 * thing being forbidden elsewhere.
 *
 * Returns `null` when the array cannot be found, which the caller turns into a
 * thrown error rather than an empty list. An empty list is a rule that reports
 * nothing and looks green.
 */
/**
 * @param {string} source
 * @returns {string[] | null}
 */
export function parseSecretKeys(source) {
  const match = /export const SECRET_KEYS = \[([\s\S]*?)\] as const;/.exec(
    source,
  );
  if (match === null || match[1] === undefined) return null;

  /** @type {string[]} */
  const names = [];
  for (const entry of match[1].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) {
    if (entry[1] !== undefined) names.push(entry[1]);
  }
  return names.length > 0 ? names : null;
}

const cache = new Map();

function secretKeysFor(cwd) {
  const cached = cache.get(cwd);
  if (cached !== undefined) return cached;

  const file = path.join(cwd, ENV_MODULE);
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `server-only/no-secret-env-access cannot read ${ENV_MODULE}. That file ` +
        `declares SECRET_KEYS, which is the list this rule enforces; without ` +
        `it the rule would pass everything. Update ENV_MODULE in ` +
        `eslint-rules/server-only.mjs if the module moved.`,
    );
  }

  const keys = parseSecretKeys(source);
  if (keys === null) {
    throw new Error(
      `server-only/no-secret-env-access could not find the SECRET_KEYS array ` +
        `in ${ENV_MODULE}. It is parsed textually, so the declaration has to ` +
        `stay \`export const SECRET_KEYS = [ … ] as const;\`.`,
    );
  }

  cache.set(cwd, keys);
  return keys;
}

/** True for `process.env`, the only object this rule cares about. */
function isProcessEnv(node) {
  return (
    node !== undefined &&
    node !== null &&
    node.type === "MemberExpression" &&
    node.computed === false &&
    node.object.type === "Identifier" &&
    node.object.name === "process" &&
    node.property.type === "Identifier" &&
    node.property.name === "env"
  );
}

/**
 * Whether the `process` in `process.env` is the real one.
 *
 * A parameter or local named `process` is a different object, and reporting on it
 * would be a false positive in code that has nothing to do with the environment.
 * An `import process from "node:process"` is *not* treated as a shadow, though —
 * it is the same object under the same name, so a rule that skipped it would be
 * one import away from being switched off.
 */
function isRealProcess(sourceCode, node) {
  let scope = sourceCode.getScope(node);

  while (scope !== null && scope !== undefined) {
    const variable = scope.variables.find((entry) => entry.name === "process");
    if (variable !== undefined) {
      return (
        variable.defs.length === 0 ||
        variable.defs.every((def) => def.type === "ImportBinding")
      );
    }
    scope = scope.upper;
  }

  return true;
}

/** The key a member access names, for `process.env.X` and `process.env["X"]` alike. */
function accessedKey(node) {
  if (node.computed) {
    return node.property.type === "Literal" &&
      typeof node.property.value === "string"
      ? node.property.value
      : null;
  }
  return node.property.type === "Identifier" ? node.property.name : null;
}

/** @type {import("eslint").Rule.RuleModule} */
const noSecretEnvAccess = {
  meta: {
    type: "problem",
    docs: {
      description:
        "read secrets through the validated, server-only env module rather than from process.env",
    },
    schema: [],
    messages: {
      rawRead:
        "`{{key}}` is a secret: read it from `serverEnv` in `@/lib/env/server`, not from `process.env`. " +
        "A raw read is invisible to the `server-only` marker — in a browser it evaluates to `undefined` " +
        "with no error at all, and on the server it skips the schema that would have refused to boot " +
        "without it.",
    },
  },

  create(context) {
    const cwd = context.cwd ?? process.cwd();
    const filename = context.filename ?? context.getFilename();
    const relative = path.relative(cwd, filename).split(path.sep).join("/");

    // The env module is where the reads are supposed to happen.
    if (relative === ENV_MODULE) return {};

    const secrets = new Set(secretKeysFor(cwd));

    const report = (node, key) => {
      if (secrets.has(key)) {
        context.report({ node, messageId: "rawRead", data: { key } });
      }
    };

    const sourceCode = context.sourceCode;

    return {
      MemberExpression(node) {
        if (!isProcessEnv(node.object)) return;
        if (!isRealProcess(sourceCode, node)) return;

        const key = accessedKey(node);
        if (key !== null) report(node, key);
      },

      // `const { NEXTAUTH_SECRET } = process.env` reaches the same value without
      // a member access, and is the first shape someone reaches for when a
      // member access starts failing lint.
      ObjectPattern(node) {
        const parent = node.parent;
        if (parent?.type !== "VariableDeclarator") return;
        if (!isProcessEnv(parent.init)) return;
        if (!isRealProcess(sourceCode, node)) return;

        for (const property of node.properties) {
          if (property.type !== "Property") continue;
          const key =
            property.key.type === "Identifier"
              ? property.key.name
              : property.key.type === "Literal" &&
                  typeof property.key.value === "string"
                ? property.key.value
                : null;
          if (key !== null) report(property, key);
        }
      },
    };
  },
};

const plugin = {
  meta: { name: "eslint-plugin-server-only", version: "1.0.0" },
  rules: { "no-secret-env-access": noSecretEnvAccess },
};

export default plugin;
