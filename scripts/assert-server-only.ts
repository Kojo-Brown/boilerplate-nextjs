/**
 * Asserts the boundary that keeps this application's secrets out of a browser.
 *
 * `import "server-only"` is the mechanism, and it is a good one: Next aliases the
 * package to a module that throws when it is compiled into a client bundle, so a
 * `"use client"` module that reaches a marked file at any depth fails
 * `next build`. This gate exists for the parts of that scheme the mechanism
 * cannot check.
 *
 *   R1  The env module still carries the marker, and the `SECRET_KEYS` list two
 *       enforcement paths read out of it still parses and still names keys the
 *       schema declares. Deleting one line in `src/lib/env/server.ts` removes
 *       every build-time guarantee below it, and nothing else in this repository
 *       would fail: the unit suite aliases `server-only` to an empty module (it
 *       has to — Vitest resolves with neither export condition), and a build with
 *       no client component importing the module is green either way.
 *
 *   R2  No module in the client graph carries the marker. `next build` fails on
 *       this too, and prints its own import trace — measured, not assumed: a
 *       probe client component importing the env module produced
 *       `'server-only' cannot be imported from a Client Component module` with
 *       the four-module chain under it (and, less helpfully, "but you are using
 *       it in the Pages Router", which this repository does not have). So this
 *       rule is not the only thing standing between a secret and a browser. It
 *       is the fast one: a static walk that answers in under a second, next to
 *       the other gates, rather than three minutes into a build — and the one
 *       that still answers when the build is not the thing being run.
 *
 *   R3  Every module that reads the server env is marked, or is somewhere Next
 *       guarantees never reaches a browser — a `"use server"` module, a route
 *       handler, a page or layout, the proxy. Without this the marker set only
 *       covers the modules someone remembered, and the next module to read a
 *       secret is protected by nothing until a client component happens to import
 *       it.
 *
 *   R4  No module reads a secret out of `process.env` directly. The
 *       `server-only/no-secret-env-access` ESLint rule is the editor-time copy of
 *       this check and the one a person will actually see; this is the copy an
 *       `eslint-disable-next-line` cannot reach. A raw read is the one way a
 *       secret arrives in a module with no import to mark: in a browser Next
 *       substitutes nothing for a name that is not `NEXT_PUBLIC_*`, so the
 *       expression is `undefined`, every check built on it quietly passes, and no
 *       build, test or gate sees anything.
 *
 *   R5  `@/lib/env/client` reaches nothing marked. It is unmarked *because* it is
 *       meant for the browser, so it is the one module where the mechanism's
 *       protection is deliberately absent — and today no client component imports
 *       it, which means a `./server` import added to it would break nothing until
 *       the first one does.
 *
 * Static analysis, so it needs no build output.
 *
 * Usage: tsx scripts/assert-server-only.ts
 */
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  collectSources,
  resolveSpecifier,
  type SourceFile,
} from "./assert-react-compiler";
import {
  browserReachability,
  withoutComments,
  withoutTypeOnlyImports,
} from "./assert-csp";
import { ENV_MODULE, parseSecretKeys } from "../eslint-rules/server-only.mjs";

export interface Finding {
  rule: "R1" | "R2" | "R3" | "R4" | "R5";
  file: string;
  message: string;
}

/** The public half of the schema, which is unmarked on purpose. */
export const CLIENT_ENV_MODULE = "src/lib/env/client.ts";

/** The bare specifier Next rewrites. Nothing else has the same effect. */
const MARKER = 'import "server-only"';

/**
 * Where Next guarantees a module runs, whatever it imports.
 *
 * A route handler, a page, a layout and the proxy are entry points the framework
 * only ever evaluates on the server, and a `"use server"` module is a boundary
 * Next replaces with a reference on the client side. Marking them would be
 * harmless and would say nothing, so R3 accepts them unmarked — the chain that
 * matters is the one that starts at a `"use client"` module, and R2 owns that.
 */
function isServerByConstruction(file: SourceFile): boolean {
  const code = withoutComments(file.text);
  if (/^\s*(?:["']use server["'];)/m.test(code.trimStart())) return true;

  const name = path.posix.basename(file.relativePath);
  if (file.relativePath === "src/proxy.ts") return true;
  if (!file.relativePath.startsWith("src/app/")) return false;

  return (
    name === "route.ts" ||
    name === "page.tsx" ||
    name === "layout.tsx" ||
    name === "default.tsx" ||
    name === "not-found.tsx" ||
    name === "sitemap.ts" ||
    name === "robots.ts" ||
    name === "opengraph-image.tsx"
  );
}

/** True when a module declares the marker in code rather than in prose. */
export function isMarked(file: SourceFile): boolean {
  return withoutComments(file.text).includes(MARKER);
}

/** Whether a module opens with `"use client"`, which is what starts a chain. */
function isClientEntry(file: SourceFile): boolean {
  const code = withoutComments(file.text).trimStart();
  return /^["']use client["']/.test(code);
}

/**
 * The chain from a `"use client"` entry point down to `leaf`, as module paths.
 *
 * Built by walking the reachability map's parent edges back to their root, so the
 * chain is the one the walk found rather than the shortest — a module imported
 * from two client components has two true answers and either serves the report.
 */
export function chainTo(
  leaf: string,
  reachedFrom: ReadonlyMap<string, string | null>,
): string[] {
  const chain = [leaf];
  const seen = new Set([leaf]);

  let current = reachedFrom.get(leaf) ?? null;
  while (current !== null && !seen.has(current)) {
    chain.unshift(current);
    seen.add(current);
    current = reachedFrom.get(current) ?? null;
  }

  return chain;
}

/**
 * The modules a given module reaches, directives ignored.
 *
 * Unlike the client-graph walk this does not stop at a `"use server"` boundary,
 * because R5 is not asking what a browser evaluates — it is asking what
 * `@/lib/env/client` depends on, and a module that imports a Server Action still
 * depends on it.
 */
export function reachableFrom(
  entry: string,
  files: readonly SourceFile[],
): Map<string, string | null> {
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  const known = new Set(byPath.keys());

  const reached = new Map<string, string | null>([[entry, null]]);
  const queue: string[] = [entry];

  while (queue.length > 0) {
    const current = queue.pop() as string;
    const file = byPath.get(current);
    if (file === undefined) continue;

    for (const match of withoutTypeOnlyImports(file.text).matchAll(
      /(?:from\s*|import\s*)["']([^"']+)["']/g,
    )) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const resolved = resolveSpecifier(current, specifier, known);
      if (resolved === null || reached.has(resolved)) continue;
      reached.set(resolved, current);
      queue.push(resolved);
    }
  }

  return reached;
}

/** Every module that imports the server env module by either spelling. */
export function serverEnvImporters(
  files: readonly SourceFile[],
): readonly SourceFile[] {
  const known = new Set(files.map((file) => file.relativePath));

  return files.filter((file) => {
    if (file.relativePath === ENV_MODULE) return false;

    for (const match of withoutTypeOnlyImports(
      withoutComments(file.text),
    ).matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const resolved = resolveSpecifier(file.relativePath, specifier, known);
      if (resolved === ENV_MODULE) return true;
    }
    return false;
  });
}

/** Raw `process.env` reads of a declared secret, outside the env module. */
export function rawSecretReads(
  files: readonly SourceFile[],
  secrets: readonly string[],
): { file: string; key: string }[] {
  const found: { file: string; key: string }[] = [];
  // Both spellings plus the destructured form, which reaches the same value.
  const pattern = new RegExp(
    String.raw`process\s*\.\s*env\s*(?:\.\s*(\w+)|\[\s*["'](\w+)["']\s*\])`,
    "g",
  );
  const destructured = /\{([^{}]*)\}\s*=\s*process\s*\.\s*env\b/g;

  for (const file of files) {
    if (file.relativePath === ENV_MODULE) continue;
    const code = withoutComments(file.text);

    for (const match of code.matchAll(pattern)) {
      const key = match[1] ?? match[2];
      if (key !== undefined && secrets.includes(key)) {
        found.push({ file: file.relativePath, key });
      }
    }

    for (const match of code.matchAll(destructured)) {
      for (const name of (match[1] ?? "").split(",")) {
        const key = name.split(":")[0]?.trim().replace(/["']/g, "") ?? "";
        if (secrets.includes(key)) {
          found.push({ file: file.relativePath, key });
        }
      }
    }
  }

  return found;
}

export function check(root: string): Finding[] {
  const findings: Finding[] = [];
  const files = collectSources(root);
  const byPath = new Map(files.map((file) => [file.relativePath, file]));

  // R1 — the marker and the list it protects.
  const envModule = byPath.get(ENV_MODULE);
  if (envModule === undefined) {
    return [
      {
        rule: "R1",
        file: ENV_MODULE,
        message:
          "does not exist. It is the module every secret is validated in and " +
          "the one this gate, the ESLint rule and the build all key on; if it " +
          "moved, all three have to move with it.",
      },
    ];
  }

  if (!isMarked(envModule)) {
    findings.push({
      rule: "R1",
      file: ENV_MODULE,
      message:
        `does not declare \`${MARKER}\`. That import is the whole enforcement: ` +
        "without it a client component importing anything that reads a secret " +
        "compiles, ships, and fails in the visitor's browser instead — if the " +
        "schema happens to notice, which it only does because the values are " +
        "absent there.",
    });
  }

  const secrets = parseSecretKeys(envModule.text);
  if (secrets === null) {
    findings.push({
      rule: "R1",
      file: ENV_MODULE,
      message:
        "no longer declares a parseable `export const SECRET_KEYS = [ … ] as " +
        "const;`. Both R4 and the ESLint rule read that array textually, so an " +
        "unparseable declaration is two checks that pass everything.",
    });
  } else {
    const schema = withoutComments(envModule.text);
    for (const key of secrets) {
      if (!new RegExp(String.raw`^\s{2}${key}:`, "m").test(schema)) {
        findings.push({
          rule: "R1",
          file: ENV_MODULE,
          message:
            `SECRET_KEYS names ${key}, which the schema above it does not ` +
            "declare. A name left behind by a rename is a secret nothing " +
            "enforces, and both readers would simply never match it.",
        });
      }
    }
  }

  // R2 — the client graph is free of markers.
  const reachedFrom = browserReachability(files);
  for (const [relativePath] of reachedFrom) {
    const file = byPath.get(relativePath);
    if (file === undefined || !isMarked(file)) continue;

    findings.push({
      rule: "R2",
      file: relativePath,
      message:
        `is marked \`${MARKER}\` and is in the client graph: ` +
        `${chainTo(relativePath, reachedFrom).join(" → ")}. ` +
        "`next build` refuses this too; this is the same answer without waiting " +
        "for a build. Either the read belongs on the server, or the value " +
        `belongs in ${CLIENT_ENV_MODULE}.`,
    });
  }

  // R3 — every reader of the server env is marked, or cannot reach a browser.
  for (const file of serverEnvImporters(files)) {
    if (isMarked(file) || isServerByConstruction(file)) continue;
    if (isClientEntry(file)) continue; // R2 has already said so, and better.

    findings.push({
      rule: "R3",
      file: file.relativePath,
      message:
        `imports ${ENV_MODULE} without declaring \`${MARKER}\` itself, and is ` +
        "not an entry point Next only runs on the server. It is protected " +
        "today only because the env module is marked; mark it too, so the " +
        "build names this module rather than one two imports away.",
    });
  }

  // R4 — no raw secret reads.
  for (const { file, key } of rawSecretReads(files, secrets ?? [])) {
    findings.push({
      rule: "R4",
      file,
      message:
        `reads ${key} from \`process.env\` directly. There is no import to ` +
        "mark on that path, so neither the marker nor the build can see it: in " +
        "a browser Next substitutes nothing for a name that is not " +
        "NEXT_PUBLIC_*, the expression is `undefined`, and every check built " +
        `on it passes. Read it from \`serverEnv\` in ${ENV_MODULE}.`,
    });
  }

  // R5 — the public env module depends on nothing marked.
  const clientEnv = byPath.get(CLIENT_ENV_MODULE);
  if (clientEnv === undefined) {
    findings.push({
      rule: "R5",
      file: CLIENT_ENV_MODULE,
      message:
        "does not exist, so there is nowhere for a `NEXT_PUBLIC_*` value to be " +
        "validated that a browser can import — which is the pressure that puts " +
        "one back into the server module.",
    });
  } else if (isMarked(clientEnv)) {
    findings.push({
      rule: "R5",
      file: CLIENT_ENV_MODULE,
      message:
        `declares \`${MARKER}\`, which leaves no validated environment a ` +
        "client component can read at all.",
    });
  } else {
    const reached = reachableFrom(CLIENT_ENV_MODULE, files);
    for (const [relativePath] of reached) {
      const file = byPath.get(relativePath);
      if (file === undefined || !isMarked(file)) continue;

      findings.push({
        rule: "R5",
        file: CLIENT_ENV_MODULE,
        message:
          `reaches ${relativePath}, which is marked \`${MARKER}\`: ` +
          `${chainTo(relativePath, reached).join(" → ")}. Nothing fails today ` +
          "because no client component imports this module yet — the first one " +
          "to do so would break the build, having changed nothing itself.",
      });
    }
  }

  return findings;
}

export function main(root: string): number {
  const findings = check(root);

  if (findings.length > 0) {
    console.error("Server-only boundary gate failed:\n");
    for (const finding of findings) {
      console.error(`${finding.file}  [${finding.rule}] ${finding.message}`);
    }
    console.error(`\n${findings.length} finding(s).`);
    return 1;
  }

  console.log(
    "Server-only boundary OK — the env module is marked, its secret list " +
      "matches the schema, no marked module is in the client graph, every " +
      "reader of the server env is marked or is a server entry point, no " +
      "secret is read from process.env directly, and the public env module " +
      "reaches nothing marked.",
  );
  return 0;
}

/* c8 ignore start -- CLI entry; the logic above is what the tests exercise. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
