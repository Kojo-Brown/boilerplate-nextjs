/**
 * Asserts that every Server Action goes through the hardening factories, so
 * that "origin checks, auth assertion, and Zod input parsing on every action"
 * is a property of the codebase rather than a habit.
 *
 * The thing this gate is really defending is a fact about Next that is easy to
 * state and easy to forget in the middle of writing a feature: **every export
 * of a `"use server"` module is an unauthenticated POST endpoint.** Not the
 * ones wired to a form — all of them, including helpers that were only ever
 * meant to be called by another action. This repository has already paid for
 * that once. `src/actions/blog.ts` used to export `revalidatePost(id)` under a
 * comment asserting that ids needed no allowlist because "this is called by the
 * post mutations, not from the browser"; it was callable from the browser with
 * any id, and no mutation ever imported it.
 *
 * A code review catches that on a good day. What a review does not reliably
 * catch is the *absence* of a leg — an action that checks the session and
 * forgets the schema looks completely normal, and the two that had done exactly
 * that (`getPresignedUploadUrlAction`, which interpolated an unvalidated
 * `filename` into an S3 key, and `deletePostAction`, which handed an
 * unvalidated argument to Prisma) had passed review, had tests, and were green.
 *
 *   A1  Every value exported from a `"use server"` module under `src/actions/`
 *       must be `export const <name> = <factory>({ … })`, where `<factory>` is
 *       one of the hardening factories — or be listed in EXEMPT with a reason.
 *
 *   A2  Those factory names must actually be imported from
 *       `@/lib/actions/define-action` or `@/lib/actions/define-authed-action`.
 *       Without this, A1 is satisfied by any local function that happens to be
 *       called `defineAction`, which is a very cheap way to make this gate
 *       green and mean nothing.
 *
 * Neither rule can prove an action's schema is *strict enough* — that is what
 * the unit tests around each action are for. They prove there is a schema, a
 * session check and an origin check at all, applied in one reviewable place.
 *
 * Usage: tsx scripts/assert-action-hardening.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** The factories that apply the three legs. */
const FACTORIES = new Set([
  "defineAction",
  "defineFormAction",
  "defineNavigationAction",
  "defineAuthedAction",
  "defineAuthedFormAction",
]);

/** The only modules a factory name may be imported from. */
const FACTORY_MODULES = new Set([
  "@/lib/actions/define-action",
  "@/lib/actions/define-authed-action",
]);

/**
 * Exports of a `"use server"` module that legitimately bypass the factories.
 *
 * Empty, and worth keeping empty. An entry here is a claim that some export is
 * safe to reach from an anonymous POST without an origin check, a session
 * assertion or a schema — which is a claim about an endpoint, so it is written
 * down with its reason rather than inferred from the shape of the code.
 */
const EXEMPT: ReadonlyArray<{ file: string; export: string; because: string }> =
  [];

interface Finding {
  rule: "A1" | "A2";
  file: string;
  line: number;
  message: string;
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

function hasExportModifier(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement)
    ? (ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
        false)
    : false;
}

/**
 * The local names a module imports from the hardening modules.
 *
 * `propertyName ?? name` so a renaming import (`defineAction as harden`) is
 * recorded under the name the call site will use, and the *imported* name is
 * what is checked against `FACTORIES`.
 */
export function importedFactoryNames(source: ts.SourceFile): Set<string> {
  const local = new Set<string>();

  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !FACTORY_MODULES.has(statement.moduleSpecifier.text)
    ) {
      continue;
    }

    // A type-only import brings in no callable value.
    if (statement.importClause?.isTypeOnly) continue;

    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;

    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (FACTORIES.has(imported)) local.add(element.name.text);
    }
  }

  return local;
}

/**
 * How one exported value is initialised.
 *
 * `kind: "call"` carries the callee's identifier when the initializer is a
 * plain call (`defineAction({ … })`); anything else — a function declaration, a
 * bare arrow, a class, an object — reports the form it found so the message can
 * name it.
 */
type ExportShape =
  { kind: "call"; callee: string } | { kind: "other"; description: string };

function shapeOf(node: ts.Node): ExportShape {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    return { kind: "call", callee: node.expression.text };
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return { kind: "other", description: "a bare function" };
  }
  if (ts.isCallExpression(node)) {
    return { kind: "other", description: "a call to a non-identifier" };
  }
  return { kind: "other", description: "not a call to a hardening factory" };
}

/** Every exported value in a module, with the shape of its initialiser. */
export function exportedValues(
  source: ts.SourceFile,
): Array<{ name: string; shape: ExportShape; node: ts.Node }> {
  const found: Array<{ name: string; shape: ExportShape; node: ts.Node }> = [];

  for (const statement of source.statements) {
    // Types and interfaces are erased before the module reaches the runtime, so
    // they are not endpoints. `export type PreviewLink` is documentation.
    if (
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement)
    ) {
      continue;
    }

    if (!hasExportModifier(statement)) continue;

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      found.push({
        name: statement.name.text,
        shape: {
          kind: "other",
          description: "an `export function` declaration",
        },
        node: statement,
      });
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      found.push({
        name: statement.name.text,
        shape: { kind: "other", description: "an exported class" },
        node: statement,
      });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        found.push({
          name: declaration.name.text,
          shape: declaration.initializer
            ? shapeOf(declaration.initializer)
            : { kind: "other", description: "an uninitialised binding" },
          node: declaration,
        });
      }
    }
  }

  return found;
}

export function checkSources(
  files: ReadonlyArray<{ relativePath: string; text: string }>,
): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    if (!file.relativePath.startsWith("src/actions/")) continue;

    const source = ts.createSourceFile(
      file.relativePath,
      file.text,
      ts.ScriptTarget.ES2022,
      true,
    );
    if (!isServerActionModule(source)) continue;

    const factories = importedFactoryNames(source);

    for (const value of exportedValues(source)) {
      const exemption = EXEMPT.find(
        (entry) =>
          entry.file === file.relativePath && entry.export === value.name,
      );
      if (exemption) continue;

      if (value.shape.kind !== "call") {
        findings.push({
          rule: "A1",
          file: file.relativePath,
          line: lineOf(source, value.node),
          message:
            `exports \`${value.name}\` as ${value.shape.description}. Every export of a ` +
            `"use server" module is a public POST endpoint, so it must be built by one of ` +
            `${[...FACTORIES].join(", ")} — which is what applies the origin check, the ` +
            `session assertion and the input schema.`,
        });
        continue;
      }

      const callee = value.shape.callee;

      if (!factories.has(callee)) {
        findings.push({
          rule: FACTORIES.has(callee) ? "A2" : "A1",
          file: file.relativePath,
          line: lineOf(source, value.node),
          message: FACTORIES.has(callee)
            ? `builds \`${value.name}\` with \`${callee}\`, which this module does not import ` +
              `from ${[...FACTORY_MODULES].join(" or ")}. A local function by that name applies ` +
              `none of the three legs.`
            : `builds \`${value.name}\` with \`${callee}()\`, which is not a hardening factory. ` +
              `Use one of ${[...FACTORIES].join(", ")}, or add \`${value.name}\` to EXEMPT in ` +
              `this script with the reason it needs no origin check, session assertion or schema.`,
        });
      }
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
        rule: "A1",
        file: entry.file,
        line: 1,
        message: "is listed in EXEMPT but does not exist. Remove the entry.",
      });
      continue;
    }

    const source = ts.createSourceFile(
      entry.file,
      file.text,
      ts.ScriptTarget.ES2022,
      true,
    );

    if (!exportedValues(source).some((value) => value.name === entry.export)) {
      findings.push({
        rule: "A1",
        file: entry.file,
        line: 1,
        message: `exempts \`${entry.export}\`, which it no longer exports. Remove the entry.`,
      });
    }
  }

  return findings;
}

/**
 * Every non-test module under `src/actions/`, read from disk.
 *
 * Narrower than the cache gate's collector on purpose: A1 and A2 are about what
 * a `"use server"` module exports, and no other directory in this repository
 * has that directive.
 */
export function collectSources(
  root: string,
): Array<{ relativePath: string; text: string }> {
  const actionsDir = path.join(root, "src", "actions");

  return readdirSync(actionsDir, { recursive: true, encoding: "utf8" })
    .map((entry) => `src/actions/${entry.split(path.sep).join("/")}`)
    .filter((relative) => /\.tsx?$/.test(relative))
    .filter((relative) => !/\.test\.tsx?$/.test(relative))
    .sort()
    .map((relativePath) => ({
      relativePath,
      text: readFileSync(path.join(root, relativePath), "utf8"),
    }));
}

export function main(root: string): number {
  const files = collectSources(root);

  if (files.length === 0) {
    console.error(
      "No sources found under src/actions/ — run this from the repo root.",
    );
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
      `\nServer Action hardening gate failed with ${findings.length} finding(s).`,
    );
    return 1;
  }

  const actionModules = files.filter((file) =>
    isServerActionModule(
      ts.createSourceFile(
        file.relativePath,
        file.text,
        ts.ScriptTarget.ES2022,
        true,
      ),
    ),
  );

  const endpoints = actionModules.reduce(
    (total, file) =>
      total +
      exportedValues(
        ts.createSourceFile(
          file.relativePath,
          file.text,
          ts.ScriptTarget.ES2022,
          true,
        ),
      ).length,
    0,
  );

  console.log(
    `Server Action hardening OK — ${actionModules.length} "use server" module(s), ` +
      `${endpoints} endpoint(s) checked, ${EXEMPT.length} documented exemption(s).`,
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
