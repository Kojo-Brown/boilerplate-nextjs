/**
 * Asserts that the dependency-advisory audit stays a *scheduled* job that
 * *opens an issue*, and keeps failing when it cannot do either.
 *
 * Everything this gate protects is invisible by absence, which is why it
 * exists at all. Delete `.github/workflows/dependency-audit.yml` and nothing
 * anywhere goes red — the repository simply stops being told about advisories,
 * and looks exactly as it does on a week with none. Add `--audit-level=high`
 * to the invocation and the same is true for every moderate finding. Add
 * `pull_request:` to the triggers and the failure is the opposite one: the
 * audit becomes the thing it was built not to be, and starts turning unrelated
 * pull requests red for somebody else's transitive package, in a repository
 * whose rule is that a red check is never merged.
 *
 *   A1  The workflow exists and has a `schedule:` trigger. A `workflow_
 *       dispatch`-only audit is one that runs when somebody already suspects
 *       something, which is the moment it is least needed.
 *
 *   A2  It has no `pull_request`, `pull_request_target` or `push` trigger.
 *       This is the item's entire premise; see the header of
 *       `scripts/audit-dependencies.ts`.
 *
 *   A3  The same rule from the other side: no `pnpm audit` in `ci.yml` or in
 *       the shipped `workflow-templates/`. A2 keeps the audit off the
 *       pull-request path; A3 keeps the pull-request path off the audit.
 *
 *   A4  `permissions:` is declared, and grants exactly `contents: read` and
 *       `issues: write`. A scheduled job that reacts to a third-party
 *       registry's response should not be able to push, and the default
 *       token is write-all in repositories that have not changed the org
 *       setting — so an absent block is not a neutral omission.
 *
 *   A5  No step in the workflow is `continue-on-error`, and no `run:` ends in
 *       `|| true`. The job is allowed to be green while advisories exist; it
 *       is not allowed to be green when it could not look. Those two are the
 *       same colour and only this rule tells them apart.
 *
 *   A6  The audit invocations carry nothing that narrows what they report.
 *       Checked against the argv the script actually executes rather than a
 *       copy in a workflow file, because that is where the flag would be
 *       added. `--audit-level` hides everything below a severity;
 *       `--ignore-registry-errors` turns an outage into a clean bill of
 *       health, which is this whole design's one unacceptable outcome.
 *
 *   A7  The workflow runs `scripts/audit-dependencies.ts`, not an inline
 *       `pnpm audit`, and not with `--dry-run`. The logic that decides
 *       whether to open, update or close an issue is a tested module; a
 *       workflow that reimplements any of it in shell has moved the decision
 *       somewhere nothing checks. `--dry-run` is the debugging flag somebody
 *       leaves behind, and it makes the job print an issue instead of filing
 *       one.
 *
 *   A8  The label the script identifies its issue by is the label the
 *       workflow's `permissions:` allow it to apply, and it is a real string
 *       in both — the issue's identity is that label, so a rename on one side
 *       makes every subsequent run open a second issue rather than update the
 *       first.
 *
 * What this gate cannot check is the part that only exists at runtime: that
 * `gh` is authenticated, that the label exists in the repository, that the
 * registry answers. Those fail the scheduled run, loudly, which is the design.
 *
 * Usage: tsx scripts/assert-advisory-audit.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  ADVISORY_LABEL,
  AUDIT_ARGS,
  PROD_AUDIT_ARGS,
} from "./audit-dependencies";
import { workflowFiles } from "./assert-action-pins";

export interface Finding {
  rule: "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7" | "A8";
  file: string;
  message: string;
}

export const AUDIT_WORKFLOW = ".github/workflows/dependency-audit.yml";
export const AUDIT_SCRIPT = "scripts/audit-dependencies.ts";
export const CI_WORKFLOW = ".github/workflows/ci.yml";

/** Triggers that would put the audit on the pull-request path. */
export const FORBIDDEN_TRIGGERS: readonly string[] = [
  "pull_request",
  "pull_request_target",
  "push",
];

/** Exactly what the job may be granted, and nothing else. */
export const REQUIRED_PERMISSIONS: readonly [string, string][] = [
  ["contents", "read"],
  ["issues", "write"],
];

/** Flags that make the audit report less than it found. */
export const MUTING_FLAGS: readonly string[] = [
  "--audit-level",
  "--ignore-registry-errors",
  "--ignore-unfixable",
];

function read(root: string, file: string): string | undefined {
  const absolute = path.join(root, file);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
}

/**
 * Lines with their comments removed.
 *
 * Every rule below is a statement about what the workflow *does*, and this
 * file's own prose names `pull_request:` and `pnpm audit` while explaining why
 * they are absent. A gate that reads its own documentation as a violation is a
 * gate that cannot be documented.
 */
function code(text: string): { line: number; text: string }[] {
  return text
    .split("\n")
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter((entry) => !/^\s*#/.test(entry.text))
    .map((entry) => ({
      line: entry.line,
      // A trailing `# …` on a real line, but not a `#` inside a quoted scalar
      // such as a cron expression.
      text: entry.text.replace(
        /\s+#(?=(?:[^"']*(?:"[^"]*"|'[^']*'))*[^"']*$).*$/,
        "",
      ),
    }));
}

/**
 * The block of a top-level key, by indentation.
 *
 * Written rather than parsed with a YAML library, for the same reason
 * `assert-action-pins.ts` reads `uses:` as text: the questions here are about
 * lines somebody would edit, the answers have to name a line number, and a
 * parsed tree cannot say where a key was written.
 */
export function topLevelBlock(
  lines: readonly { line: number; text: string }[],
  key: string,
): { line: number; text: string }[] {
  const startIndex = lines.findIndex((entry) =>
    new RegExp(`^${key}:\\s*(?:\\S.*)?$`).test(entry.text),
  );
  if (startIndex === -1) return [];

  const block = [lines[startIndex] as { line: number; text: string }];

  for (const entry of lines.slice(startIndex + 1)) {
    if (entry.text.trim() === "") continue;
    if (/^\S/.test(entry.text)) break;
    block.push(entry);
  }

  return block;
}

function checkTriggers(
  lines: readonly { line: number; text: string }[],
  findings: Finding[],
): void {
  // `on` is a YAML 1.1 boolean, so GitHub also accepts the quoted spellings.
  const block = ["on", '"on"', "'on'"]
    .map((key) => topLevelBlock(lines, key))
    .find((found) => found.length > 0);

  if (block === undefined || block.length < 2) {
    findings.push({
      rule: "A1",
      file: AUDIT_WORKFLOW,
      message:
        "declares no triggers. A workflow nothing starts is a file, and a " +
        "missing advisory report reads exactly like a clean dependency tree.",
    });
    return;
  }

  if (!block.some((entry) => /^\s+schedule:\s*$/.test(entry.text))) {
    findings.push({
      rule: "A1",
      file: AUDIT_WORKFLOW,
      message:
        "has no `schedule:` trigger. On demand only means the audit runs " +
        "when somebody already suspects something, which is the one moment " +
        "it adds nothing.",
    });
  }

  for (const entry of block.slice(1)) {
    const match = /^\s+(\w+):/.exec(entry.text);
    const trigger = match?.[1];
    if (trigger === undefined || !FORBIDDEN_TRIGGERS.includes(trigger))
      continue;

    findings.push({
      rule: "A2",
      file: `${AUDIT_WORKFLOW}:${entry.line}`,
      message:
        `is triggered by \`${trigger}\`. That is the shape this job exists ` +
        "not to have: an advisory published against a transitive package " +
        "would turn every unrelated pull request red, in a repository whose " +
        "rule is that a red check is never merged.",
    });
  }
}

/** A3 — the audit has not been smuggled back onto the pull-request path. */
function checkNotAGate(root: string, findings: Finding[]): void {
  for (const { file, text } of workflowFiles(root)) {
    if (file === AUDIT_WORKFLOW) continue;

    for (const entry of code(text)) {
      if (!/\bpnpm\s+(?:\S+\s+)*audit\b/.test(entry.text)) continue;

      findings.push({
        rule: "A3",
        file: `${file}:${entry.line}`,
        message:
          "runs `pnpm audit`. Every workflow here other than the scheduled " +
          "audit runs on a pull request or ships to somebody who will run " +
          `it on one, and \`${AUDIT_WORKFLOW}\` is where the audit lives ` +
          "precisely so that it never decides a pull request's colour.",
      });
    }
  }
}

function checkPermissions(
  lines: readonly { line: number; text: string }[],
  findings: Finding[],
): void {
  const block = topLevelBlock(lines, "permissions");

  if (block.length === 0) {
    findings.push({
      rule: "A4",
      file: AUDIT_WORKFLOW,
      message:
        "declares no `permissions:`. The default is whatever the repository " +
        "or organisation setting says, which is still write-all in plenty " +
        "of them — an omission here is a grant, not a neutral default.",
    });
    return;
  }

  const granted = new Map<string, { value: string; line: number }>();
  for (const entry of block.slice(1)) {
    const match = /^\s+([\w-]+):\s*(\S+)\s*$/.exec(entry.text);
    if (match === null) continue;
    granted.set(match[1] as string, {
      value: match[2] as string,
      line: entry.line,
    });
  }

  for (const [scope, expected] of REQUIRED_PERMISSIONS) {
    const actual = granted.get(scope);

    if (actual === undefined) {
      findings.push({
        rule: "A4",
        file: AUDIT_WORKFLOW,
        message:
          `grants no \`${scope}\` permission. The job checks out the ` +
          "lockfile and files an issue; without both it cannot do either " +
          "half of its work, and the half it silently loses is the report.",
      });
      continue;
    }

    if (actual.value !== expected) {
      findings.push({
        rule: "A4",
        file: `${AUDIT_WORKFLOW}:${actual.line}`,
        message:
          `grants \`${scope}: ${actual.value}\` where \`${expected}\` is ` +
          "what the job needs.",
      });
    }
  }

  for (const [scope, actual] of granted) {
    if (REQUIRED_PERMISSIONS.some(([required]) => required === scope)) continue;

    findings.push({
      rule: "A4",
      file: `${AUDIT_WORKFLOW}:${actual.line}`,
      message:
        `also grants \`${scope}: ${actual.value}\`. This job reacts to a ` +
        "third-party registry's response on a timer with nobody watching; " +
        "every scope beyond reading the tree and writing an issue is one it " +
        "does not need and cannot justify.",
    });
  }
}

/** A5 — the job may be green with findings, never green without looking. */
function checkFailsLoudly(
  lines: readonly { line: number; text: string }[],
  findings: Finding[],
): void {
  for (const entry of lines) {
    if (/continue-on-error:\s*true/.test(entry.text)) {
      findings.push({
        rule: "A5",
        file: `${AUDIT_WORKFLOW}:${entry.line}`,
        message:
          "sets `continue-on-error: true`. A step allowed to fail quietly " +
          "produces no issue and a green check, which is byte for byte what " +
          "a clean dependency tree produces.",
      });
    }

    // Comments are already stripped, so this is a line that runs.
    if (/\|\|\s*(?:true|:)\s*(?:\\)?\s*$/.test(entry.text)) {
      findings.push({
        rule: "A5",
        file: `${AUDIT_WORKFLOW}:${entry.line}`,
        message:
          "short-circuits a failure with `|| true`. Same failure as " +
          "`continue-on-error`, one line " +
          "lower: the audit's only unacceptable outcome is looking like it " +
          "ran when it did not.",
      });
    }
  }
}

/**
 * A6 — nothing narrows what the audit reports.
 *
 * Takes the two argument lists rather than reading the module's exports
 * directly, so the rule can be shown failing on the flag it names. A test that
 * can only run against the constants as they stand proves the gate agrees with
 * today's source and nothing about what it would do to tomorrow's.
 */
export function auditArgFindings(
  full: readonly string[] = AUDIT_ARGS,
  prod: readonly string[] = PROD_AUDIT_ARGS,
): Finding[] {
  const findings: Finding[] = [];

  for (const args of [full, prod]) {
    for (const flag of MUTING_FLAGS) {
      if (!args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) {
        continue;
      }

      findings.push({
        rule: "A6",
        file: AUDIT_SCRIPT,
        message:
          `runs \`pnpm ${args.join(" ")}\`, which carries \`${flag}\`. ` +
          "Every flag on that list turns something the audit found into " +
          "something it did not report, and the report is the only output " +
          "this job has.",
      });
    }
  }

  if (!full.includes("--json") || !prod.includes("--json")) {
    findings.push({
      rule: "A6",
      file: AUDIT_SCRIPT,
      message:
        "runs an audit without `--json`. The human-readable output is not a " +
        "format anything can reconcile an issue from, and parsing it would " +
        "fail by finding nothing.",
    });
  }

  if (!prod.includes("--prod")) {
    findings.push({
      rule: "A6",
      file: AUDIT_SCRIPT,
      message:
        "no longer runs a `--prod` audit. Without it every advisory reads " +
        "the same, and the difference between a seed script's dependency " +
        "and the deployed artifact is the triage.",
    });
  }

  return findings;
}

/** A7 — the workflow runs the tested module, in earnest. */
function checkInvocation(
  lines: readonly { line: number; text: string }[],
  findings: Finding[],
): void {
  const invocations = lines.filter((entry) =>
    entry.text.includes(AUDIT_SCRIPT),
  );

  if (invocations.length === 0) {
    findings.push({
      rule: "A7",
      file: AUDIT_WORKFLOW,
      message:
        `never runs \`${AUDIT_SCRIPT}\`. Whether to open, update or close ` +
        "the issue is decided by a module with tests; a workflow that does " +
        "any of it in shell has moved the decision somewhere nothing reads.",
    });
    return;
  }

  for (const entry of invocations) {
    if (!entry.text.includes("--dry-run")) continue;

    findings.push({
      rule: "A7",
      file: `${AUDIT_WORKFLOW}:${entry.line}`,
      message:
        "runs the audit with `--dry-run`, which prints the issue instead of " +
        "filing it. That is the flag somebody debugs with and leaves behind, " +
        "and the job stays green either way.",
    });
  }
}

/**
 * A8 — one label, spelled the same in both places.
 *
 * The label is the issue's identity: the script finds last week's issue by
 * listing open issues carrying it, and applies it to the one it opens. Two
 * things follow, and both are silent.
 *
 * The label has to *exist* before the first `gh issue create --label`, which
 * fails outright against a label the repository does not have — so the
 * workflow creates it, idempotently, ahead of the run. And the two spellings
 * have to agree: renamed on the workflow's side, every run applies a label
 * the next run does not search for, so nothing is ever found, nothing is ever
 * closed, and Monday files a fresh issue forever.
 */
function checkLabel(
  lines: readonly { line: number; text: string }[],
  findings: Finding[],
): void {
  if (!/^[\w.-]+$/.test(ADVISORY_LABEL)) {
    findings.push({
      rule: "A8",
      file: AUDIT_SCRIPT,
      message:
        `exports \`ADVISORY_LABEL = "${ADVISORY_LABEL}"\`, which is not a ` +
        "plain label name. An empty one makes `gh issue list --label ''` " +
        "match every open issue in the repository, and the next run rewrites " +
        "whichever it finds first.",
    });
    return;
  }

  const creations = lines.filter((entry) =>
    /\bgh\s+label\s+create\b/.test(entry.text),
  );

  if (creations.length === 0) {
    findings.push({
      rule: "A8",
      file: AUDIT_WORKFLOW,
      message:
        "never creates the advisory label. `gh issue create --label` fails " +
        `against a label the repository does not have, so \`${ADVISORY_LABEL}\` ` +
        "has to be ensured before the first run rather than assumed.",
    });
    return;
  }

  for (const entry of creations) {
    if (
      new RegExp(
        `\\bgh\\s+label\\s+create\\s+["']?${ADVISORY_LABEL}["']?(\\s|$)`,
      ).test(entry.text)
    ) {
      return;
    }
  }

  findings.push({
    rule: "A8",
    file: `${AUDIT_WORKFLOW}:${creations[0]?.line ?? 1}`,
    message:
      `creates a label that is not \`${ADVISORY_LABEL}\`, which is what ` +
      `${AUDIT_SCRIPT} searches for. One rename and every run applies a ` +
      "label the next run does not look for: nothing is found, nothing is " +
      "closed, and a fresh issue is filed every week.",
  });
}

export function check(root: string): Finding[] {
  const findings: Finding[] = [];
  const source = read(root, AUDIT_WORKFLOW);

  if (source === undefined) {
    return [
      {
        rule: "A1",
        file: AUDIT_WORKFLOW,
        message:
          "is missing. Nothing else in this repository looks at the pinned " +
          "tree for a published advisory, and its absence is indis" +
          "tinguishable from a week with none — see docs/dependency-" +
          "advisories.md.",
      },
    ];
  }

  const lines = code(source);

  checkTriggers(lines, findings);
  checkNotAGate(root, findings);
  checkPermissions(lines, findings);
  checkFailsLoudly(lines, findings);
  findings.push(...auditArgFindings());
  checkInvocation(lines, findings);
  checkLabel(lines, findings);

  if (!existsSync(path.join(root, AUDIT_SCRIPT))) {
    findings.push({
      rule: "A7",
      file: AUDIT_SCRIPT,
      message:
        "is missing, so the workflow above runs nothing. The audit's logic " +
        "lives here because a reconciler that re-opens a closed issue, or " +
        "rewrites an unchanged body every Monday, still looks like it works.",
    });
  }

  return findings;
}

export function main(root: string): number {
  const findings = check(root);

  if (findings.length > 0) {
    console.error("Dependency-advisory audit gate failed:\n");
    for (const finding of findings) {
      console.error(`${finding.file}  [${finding.rule}] ${finding.message}`);
    }
    console.error(`\n${findings.length} finding(s).`);
    return 1;
  }

  console.log(
    `Advisory audit OK — ${AUDIT_WORKFLOW} runs on a schedule and never on ` +
      `a pull request, holds \`contents: read\` and \`issues: write\` and ` +
      `nothing else, fails rather than skips, and runs ${AUDIT_SCRIPT} with ` +
      `an unnarrowed \`pnpm ${AUDIT_ARGS.join(" ")}\`.`,
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
