/**
 * Asserts that every Server Action which writes to the database tells the cache
 * about it, and that no module invents cache tags on the side.
 *
 * This gate exists because the failure it catches is invisible everywhere else.
 * The three post mutations wrote rows correctly, returned the right values,
 * passed thirteen unit tests, and left the public blog serving a list without
 * the post that had just been published — for up to sixty seconds, and up to
 * five minutes for the post's own page. Nothing failed. `revalidatePath` was
 * being called, so an eye scanning the file saw invalidation happening; it just
 * named a route whose reads are uncached. Meanwhile the helper that would have
 * dropped the right tags sat in `src/actions/blog.ts`, fully unit-tested, and
 * imported by nobody.
 *
 * The property both halves of that violate is checkable without running
 * anything: a write and its invalidation are two calls in one function body.
 *
 *   R1  An exported function in `src/actions/` that performs a Prisma write
 *       must call `invalidate(...)`, or be listed in EXEMPT with a reason.
 *
 *   R2  Only `src/lib/cache/invalidation.ts` may import Next's invalidation
 *       APIs. A mutation that reaches for `updateTag` directly has minted a
 *       tag string at a call site, which is how the read and write halves of a
 *       tag contract drift apart without either failing.
 *
 * Neither rule can prove a mutation drops the *right* tags — that is what
 * `src/lib/cache/invalidation.test.ts` is for. They prove it makes the decision
 * at all, in the one place the decision is reviewable.
 *
 * Usage: tsx scripts/assert-cache-invalidation.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** Prisma client methods that write. Reads are not this gate's business. */
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "executeRaw",
  "executeRawUnsafe",
]);

/** The `next/cache` exports that drop cache entries or signal a revalidation. */
const INVALIDATION_APIS = new Set([
  "updateTag",
  "revalidateTag",
  "revalidatePath",
  "refresh",
]);

/** The module allowed to call them, relative to the repository root. */
const INVALIDATION_MODULE = "src/lib/cache/invalidation.ts";

/** The function that must appear in a writing action's body. */
const INVALIDATE_CALL = "invalidate";

/**
 * Writing actions that legitimately invalidate nothing.
 *
 * An exemption is a claim that no cached entry anywhere depends on the rows
 * this action writes. That is a real thing to be true, and also exactly the
 * kind of claim that stops being true quietly — so it is written down, with the
 * reason, rather than being inferred from the absence of a call.
 */
const EXEMPT: ReadonlyArray<{ file: string; export: string; because: string }> =
  [
    {
      file: "src/actions/auth.ts",
      export: "registerAction",
      because:
        "Creates a User row. The only cached reads are the blog's, which " +
        "select an author's name through their posts — and an account that " +
        "was created a moment ago has none. A cached entry can only start " +
        "depending on this row once that user publishes, which goes through " +
        "togglePublishAction and invalidates there.",
    },
  ];

interface Finding {
  rule: "R1" | "R2";
  file: string;
  line: number;
  message: string;
}

/**
 * The exported values in a source file, each paired with the subtree that holds
 * its code.
 *
 * Two forms are recognised:
 *
 *   export function name() { … }          body = the function body
 *   export const name = <initializer>     body = the whole initializer
 *
 * The second arrived with the hardening factories: every Server Action is now
 * `export const name = defineAuthedAction({ handler: … })`, and its writes and
 * its `invalidate()` call sit inside that object literal. Taking the entire
 * initializer as the body is deliberately blunt — both checks below walk a
 * subtree looking for a call, and the handler is somewhere in that subtree
 * whether it was written as a method, an arrow, or wrapped in another helper.
 * A narrower walker that went looking for a property named `handler` would stop
 * seeing the code the moment an action was composed differently, and failing to
 * *see* a mutation is precisely the silent pass this gate exists to prevent.
 *
 * Anything else a module exports has no body to read; `checkSources`
 * cross-checks this list against `exportedValueNames` and fails on it rather
 * than passing it silently.
 */
function exportedFunctions(
  source: ts.SourceFile,
): Array<{ name: string; body: ts.Node; node: ts.Node }> {
  const found: Array<{ name: string; body: ts.Node; node: ts.Node }> = [];

  for (const statement of source.statements) {
    const isExported = ts.canHaveModifiers(statement)
      ? ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (!isExported) continue;

    if (ts.isFunctionDeclaration(statement)) {
      if (!statement.body || !statement.name) continue;
      found.push({
        name: statement.name.text,
        body: statement.body,
        node: statement,
      });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue;
        }
        found.push({
          name: declaration.name.text,
          body: declaration.initializer,
          node: declaration,
        });
      }
    }
  }

  return found;
}

/**
 * Every *value* a module exports.
 *
 * Type aliases and interfaces are excluded because they are erased before the
 * module ever reaches the runtime — `export type RevalidateTarget` is not an
 * action endpoint and has no body to check. Everything left is something a
 * caller could invoke.
 */
function exportedValueNames(source: ts.SourceFile): string[] {
  const names: string[] = [];

  for (const statement of source.statements) {
    if (
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement)
    ) {
      continue;
    }

    const isExported = ts.canHaveModifiers(statement)
      ? ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      : false;

    if (!isExported) continue;

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          names.push(declaration.name.text);
      }
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      names.push(statement.name.text);
    }
  }

  return names;
}

/** Whether a node's subtree contains a `prisma.<model>.<write>(...)` call. */
function containsPrismaWrite(root: ts.Node): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;

      // `prisma.post.create(...)` — the receiver of the write method is itself
      // a property access whose root identifier is `prisma`. Matching on the
      // root rather than the whole text keeps `prisma.$transaction(...)` and
      // aliased clients in scope without hardcoding model names.
      if (WRITE_METHODS.has(method)) {
        if (
          ts.isPropertyAccessExpression(receiver) &&
          ts.isIdentifier(receiver.expression) &&
          receiver.expression.text === "prisma"
        ) {
          found = true;
          return;
        }
        if (ts.isIdentifier(receiver) && receiver.text === "prisma") {
          found = true;
          return;
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(root);
  return found;
}

/** Whether a node's subtree calls `invalidate(...)`. */
function containsInvalidateCall(root: ts.Node): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === INVALIDATE_CALL
    ) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(root);
  return found;
}

/** Whether a file opens with the `"use server"` directive. */
function isServerActionModule(source: ts.SourceFile): boolean {
  const first = source.statements[0];
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use server"
  );
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export function checkSources(
  files: ReadonlyArray<{ relativePath: string; text: string }>,
): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    const source = ts.createSourceFile(
      file.relativePath,
      file.text,
      ts.ScriptTarget.ES2022,
      true,
      file.relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    // R2 — the import check, which applies to every non-test module.
    if (file.relativePath !== INVALIDATION_MODULE) {
      for (const statement of source.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          statement.moduleSpecifier.text !== "next/cache"
        ) {
          continue;
        }

        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;

        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (!INVALIDATION_APIS.has(imported)) continue;

          findings.push({
            rule: "R2",
            file: file.relativePath,
            line: lineOf(source, element),
            message:
              `imports \`${imported}\` from next/cache. Only ${INVALIDATION_MODULE} ` +
              `may call Next's invalidation APIs — add a CacheMutation variant there ` +
              `and call \`invalidate()\` instead, so the tag stays defined in one place.`,
          });
        }
      }
    }

    // R1 — the write/invalidate check, which applies to Server Actions only.
    if (!file.relativePath.startsWith("src/actions/")) continue;
    if (!isServerActionModule(source)) continue;

    const functions = exportedFunctions(source);

    // The walker only recognises `export function` declarations. If a module
    // exports something else, this gate is silently not checking it — which is
    // a worse outcome than a false positive, so it fails instead.
    const recognised = new Set(functions.map((fn) => fn.name));
    for (const name of exportedValueNames(source)) {
      if (recognised.has(name)) continue;
      findings.push({
        rule: "R1",
        file: file.relativePath,
        line: 1,
        message:
          `exports \`${name}\`, which is not an \`export function\` declaration. ` +
          `This gate can only read that form, so \`${name}\` is unchecked. Declare ` +
          `it as a function, or teach \`exportedFunctions\` the new form.`,
      });
    }

    for (const fn of functions) {
      if (!containsPrismaWrite(fn.body)) continue;
      if (containsInvalidateCall(fn.body)) continue;

      const exemption = EXEMPT.find(
        (entry) => entry.file === file.relativePath && entry.export === fn.name,
      );
      if (exemption) continue;

      findings.push({
        rule: "R1",
        file: file.relativePath,
        line: lineOf(source, fn.node),
        message:
          `\`${fn.name}\` writes to the database but never calls \`${INVALIDATE_CALL}()\`. ` +
          `Report the mutation to @/lib/cache/invalidation so the cached reads that ` +
          `depend on those rows are dropped — or, if none do, add it to EXEMPT in ` +
          `this script with the reason.`,
      });
    }
  }

  return findings;
}

/** Stale exemptions are their own failure — they read as a reviewed decision. */
export function checkExemptions(
  files: ReadonlyArray<{ relativePath: string; text: string }>,
): Finding[] {
  const findings: Finding[] = [];

  for (const entry of EXEMPT) {
    const file = files.find(
      (candidate) => candidate.relativePath === entry.file,
    );

    if (!file) {
      findings.push({
        rule: "R1",
        file: entry.file,
        line: 1,
        message: `is listed in EXEMPT but does not exist. Remove the entry.`,
      });
      continue;
    }

    const source = ts.createSourceFile(
      entry.file,
      file.text,
      ts.ScriptTarget.ES2022,
      true,
    );
    const fn = exportedFunctions(source).find((f) => f.name === entry.export);

    if (!fn) {
      findings.push({
        rule: "R1",
        file: entry.file,
        line: 1,
        message: `exempts \`${entry.export}\`, which it no longer exports. Remove the entry.`,
      });
      continue;
    }

    if (!containsPrismaWrite(fn.body)) {
      findings.push({
        rule: "R1",
        file: entry.file,
        line: lineOf(source, fn.node),
        message:
          `exempts \`${entry.export}\` from invalidation, but it no longer writes ` +
          `to the database. Remove the entry so the exemption list stays a list of ` +
          `decisions someone actually has to make.`,
      });
    }
  }

  return findings;
}

/**
 * Every non-test module under `src/`, read from disk.
 *
 * Test files are excluded from both rules on purpose: `blog.test.ts` imports
 * `updateTag` from `next/cache` in order to assert against its mock, which is
 * the opposite of the drift R2 exists to prevent.
 */
export function collectSources(
  root: string,
): Array<{ relativePath: string; text: string }> {
  const srcDir = path.join(root, "src");

  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .map((entry) => `src/${entry.split(path.sep).join("/")}`)
    .filter((relative) => /\.tsx?$/.test(relative))
    .filter((relative) => !/\.test\.tsx?$/.test(relative))
    .filter((relative) => !relative.startsWith("src/test/"))
    .sort()
    .map((relativePath) => ({
      relativePath,
      text: readFileSync(path.join(root, relativePath), "utf8"),
    }));
}

export function main(root: string): number {
  const files = collectSources(root);

  if (files.length === 0) {
    console.error("No sources found under src/ — run this from the repo root.");
    return 1;
  }

  const findings = [...checkSources(files), ...checkExemptions(files)];

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(
        `${finding.file}:${finding.line}  [${finding.rule}] ${finding.message}`,
      );
    }
    console.error(
      `\nCache invalidation gate failed with ${findings.length} finding(s).`,
    );
    return 1;
  }

  const actionModules = files.filter(
    (file) =>
      file.relativePath.startsWith("src/actions/") &&
      isServerActionModule(
        ts.createSourceFile(
          file.relativePath,
          file.text,
          ts.ScriptTarget.ES2022,
          true,
        ),
      ),
  );

  console.log(
    `Cache invalidation OK — ${files.length} module(s) scanned, ` +
      `${actionModules.length} Server Action module(s) checked, ` +
      `${EXEMPT.length} documented exemption(s).`,
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
