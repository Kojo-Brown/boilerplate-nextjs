/**
 * Audits the pinned dependency tree for known advisories and reconciles the
 * result into a single GitHub issue.
 *
 * This is the other half of A06. Dependabot points at what changed; nothing
 * here looked at what did *not* change. A version pinned eighteen months ago
 * and never touched is the one an advisory is most likely to be published
 * against, and the one no pull request will ever mention.
 *
 * ## Why an issue and not a check
 *
 * `pnpm audit` is deliberately not a pull-request gate, and that decision is
 * older than this file — it is written into `.github/dependabot.yml` and into
 * `docs/owasp-top-10.md`. An advisory is published by somebody else, against
 * code somebody else wrote, at a moment nobody here chose. Wiring that to the
 * pull-request check means an unrelated typo fix goes red for a transitive
 * package it does not import, in a repository whose stated rule is that a red
 * check is never merged. The rule survives about a week of that, and what
 * replaces it is people merging red, which costs more than the advisory.
 *
 * An issue decouples the two clocks. The advisory arrives on the registry's
 * schedule and is triaged on a person's; the pull request stays about the
 * change in it.
 *
 * ## What must never happen
 *
 * The failure mode of this job is **silence**, and silence is indistinguishable
 * from a clean tree. A registry outage, a `gh` that cannot authenticate, a
 * parse error against an output format that changed under us — every one of
 * them produces no issue, which is exactly what a healthy dependency tree also
 * produces.
 *
 * So the rule is narrower than "never fail": this job must never fail *a pull
 * request*, and must always fail *itself* when it could not do its work. Every
 * error below is thrown rather than logged. The one thing that is not an error
 * is finding advisories, which is the job succeeding.
 *
 * That is also why the audit is run without `--audit-level` and without
 * `--ignore-registry-errors`. Both turn a finding into a non-finding, and the
 * second turns an outage into a clean bill of health. Rule A6 of
 * `scripts/assert-advisory-audit.ts` fails their reappearance.
 *
 * ## Production reachability
 *
 * Every advisory is run past a second, production-only audit. `@faker-js/faker`
 * shipping an `eval` path matters to whoever runs the seed script and to nobody
 * in production; a path-traversal in `next` is the deployment. Both belong in
 * the issue, and a reader who cannot tell them apart at a glance triages
 * neither. There is no way to derive this from the first audit's output —
 * `paths` records the resolution chain (`.>next>postcss`) and not whether the
 * root edge was a `dependencies` entry — so it costs a second call.
 *
 * Usage:
 *   tsx scripts/audit-dependencies.ts --dry-run   # print the plan, touch nothing
 *   tsx scripts/audit-dependencies.ts             # reconcile the issue via `gh`
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * The label that identifies this job's issue.
 *
 * Identity is the label and not the title, because the title carries counts
 * that change every time the tree does. `scripts/assert-advisory-audit.ts`
 * rule A7 checks that the workflow creates this same string.
 */
export const ADVISORY_LABEL = "dependency-advisory";

/** Only ever one open issue at a time; this is its title's fixed prefix. */
export const ISSUE_TITLE_PREFIX = "Dependency advisories";

/**
 * The audit invocations, verbatim.
 *
 * Exported so the gate can assert on the arguments that actually run rather
 * than on a copy of them in a workflow file. Anything that narrows what the
 * audit reports belongs in neither array — see the header.
 */
export const AUDIT_ARGS: readonly string[] = ["audit", "--json"];
export const PROD_AUDIT_ARGS: readonly string[] = ["audit", "--prod", "--json"];

/** Highest first. This is the order the issue body is written in. */
export const SEVERITIES = [
  "critical",
  "high",
  "moderate",
  "low",
  "info",
] as const;

export type Severity = (typeof SEVERITIES)[number];

/** One advisory, reduced to what a person triaging it needs. */
export interface Advisory {
  id: string;
  severity: Severity;
  module: string;
  title: string;
  url: string;
  vulnerableVersions: string;
  patchedVersions: string;
  /** The installed versions the audit matched, deduplicated. */
  installed: string[];
  /** Resolution chains, `.>next>postcss` as the registry writes them. */
  paths: string[];
  cves: string[];
  /** Whether the package is reachable from `dependencies` at the root. */
  production: boolean;
}

export interface AuditResult {
  advisories: Advisory[];
  /** Advisory identifiers muted by `pnpm.auditConfig` in package.json. */
  muted: string[];
  totalDependencies: number;
}

/** Runs a command and hands back its stdout. Substituted in tests. */
export type Runner = (command: string, args: readonly string[]) => string;

const runCommand: Runner = (command, args) =>
  execFileSync(command, [...args], {
    encoding: "utf8",
    // The audit output is JSON on stdout; pnpm's progress lines go to stderr
    // and are not ours to read. 32 MiB because the default 1 MiB buffer is
    // comfortably exceeded by thirty advisories carrying their full overview.
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });

/**
 * `pnpm audit --json` exits non-zero whenever it found something, which is the
 * normal case here, so the exit code carries no information this code can use.
 * What separates "audited, found things" from "did not audit" is whether the
 * output parses into the shape below — so that, and not the exit status, is
 * what is checked.
 */
function runAuditCommand(run: Runner, args: readonly string[]): unknown {
  let stdout: string;

  try {
    stdout = run("pnpm", args);
  } catch (error: unknown) {
    // execFileSync throws on a non-zero exit and still carries the output.
    const captured = (error as { stdout?: string | Buffer }).stdout;
    if (captured === undefined) throw error;
    stdout = captured.toString();
  }

  const trimmed = stdout.trim();
  if (trimmed === "") {
    throw new Error(
      `\`pnpm ${args.join(" ")}\` produced no output. An audit that did not ` +
        "run is not an audit that found nothing.",
    );
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(
      `\`pnpm ${args.join(" ")}\` did not produce JSON. First 200 ` +
        `characters: ${trimmed.slice(0, 200)}`,
    );
  }
}

function isSeverity(value: unknown): value is Severity {
  return SEVERITIES.includes(value as Severity);
}

interface RawFinding {
  version?: unknown;
  paths?: unknown;
}

interface RawAdvisory {
  id?: unknown;
  github_advisory_id?: unknown;
  severity?: unknown;
  module_name?: unknown;
  title?: unknown;
  url?: unknown;
  vulnerable_versions?: unknown;
  patched_versions?: unknown;
  cves?: unknown;
  findings?: unknown;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

/**
 * The registry's advisory shape, narrowed.
 *
 * Every field is re-checked rather than cast. This output is a remote service's
 * response and the one place a change in it must not be silently tolerated: a
 * `severity` that stopped being a string would otherwise sort into a group
 * nobody reads.
 */
function toAdvisory(key: string, raw: RawAdvisory, production: boolean) {
  const severity = raw.severity;
  if (!isSeverity(severity)) {
    throw new Error(
      `advisory ${key} has severity ${JSON.stringify(severity)}, which is ` +
        `not one of ${SEVERITIES.join(", ")}.`,
    );
  }

  const packageName = raw.module_name;
  if (typeof packageName !== "string" || packageName === "") {
    throw new Error(`advisory ${key} names no module.`);
  }

  const findings = Array.isArray(raw.findings)
    ? (raw.findings as RawFinding[])
    : [];

  const installed = [
    ...new Set(
      findings
        .map((finding) => finding.version)
        .filter((version): version is string => typeof version === "string"),
    ),
  ].sort();

  const paths = [
    ...new Set(findings.flatMap((finding) => strings(finding.paths))),
  ].sort();

  const ghsa =
    typeof raw.github_advisory_id === "string" && raw.github_advisory_id !== ""
      ? raw.github_advisory_id
      : undefined;

  return {
    // The GHSA identifier where there is one: the numeric key is the registry's
    // own and means nothing to anybody reading the issue.
    id: ghsa ?? String(raw.id ?? key),
    severity,
    module: packageName,
    title: typeof raw.title === "string" ? raw.title : "(untitled advisory)",
    url: typeof raw.url === "string" ? raw.url : "",
    vulnerableVersions:
      typeof raw.vulnerable_versions === "string"
        ? raw.vulnerable_versions
        : "",
    patchedVersions:
      typeof raw.patched_versions === "string" ? raw.patched_versions : "",
    installed,
    paths,
    cves: strings(raw.cves).sort(),
    production,
  } satisfies Advisory;
}

interface RawReport {
  advisories?: Record<string, RawAdvisory>;
  muted?: unknown;
  metadata?: { totalDependencies?: unknown };
}

function asReport(value: unknown, args: readonly string[]): RawReport {
  if (typeof value !== "object" || value === null) {
    throw new Error(`\`pnpm ${args.join(" ")}\` returned a non-object.`);
  }

  const report = value as RawReport;
  if (typeof report.advisories !== "object" || report.advisories === null) {
    throw new Error(
      `\`pnpm ${args.join(" ")}\` returned no \`advisories\` object. The ` +
        "output format changed, and reading it as empty would report a clean " +
        "tree.",
    );
  }

  return report;
}

/** A stable ordering: severity first, then module, then identifier. */
export function compareAdvisories(a: Advisory, b: Advisory): number {
  const bySeverity =
    SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);
  if (bySeverity !== 0) return bySeverity;
  if (a.module !== b.module) return a.module < b.module ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Both audits, merged.
 *
 * The production run is the authority on reachability and on nothing else: an
 * advisory it reports and the full run does not would mean the two disagree
 * about the tree, which is a bug rather than a finding, so the full run's set
 * is what is returned.
 */
export function audit(run: Runner = runCommand): AuditResult {
  const full = asReport(runAuditCommand(run, AUDIT_ARGS), AUDIT_ARGS);
  const prod = asReport(runAuditCommand(run, PROD_AUDIT_ARGS), PROD_AUDIT_ARGS);

  const productionKeys = new Set(Object.keys(prod.advisories ?? {}));

  const advisories = Object.entries(full.advisories ?? {})
    .map(([key, raw]) => toAdvisory(key, raw, productionKeys.has(key)))
    .sort(compareAdvisories);

  const total = full.metadata?.totalDependencies;

  return {
    advisories,
    // Surfaced rather than trusted: a mute in `pnpm.auditConfig` is invisible
    // in every other view of this repository, and the one process that exists
    // to notice advisories is the worst place for it to stay invisible.
    muted: strings(full.muted).sort(),
    totalDependencies: typeof total === "number" ? total : 0,
  };
}

export function countBySeverity(
  advisories: readonly Advisory[],
): Record<Severity, number> {
  const counts = Object.fromEntries(
    SEVERITIES.map((severity) => [severity, 0]),
  ) as Record<Severity, number>;

  for (const advisory of advisories) counts[advisory.severity] += 1;
  return counts;
}

/**
 * What the issue is *about*, as opposed to what it says.
 *
 * Deliberately excludes the dependency total, the date and the ordering of the
 * paths: a weekly run that rewrote the body every time would bury the one week
 * the set actually changed under fifty-one weeks of noise. Includes the
 * production flag, because an advisory crossing into the production graph is a
 * change in what it means even when the advisory itself has not moved.
 */
export function fingerprint(advisories: readonly Advisory[]): string {
  const material = [...advisories]
    .sort(compareAdvisories)
    .map((advisory) =>
      [
        advisory.id,
        advisory.severity,
        advisory.module,
        advisory.installed.join(","),
        advisory.production ? "prod" : "dev",
      ].join("\u0000"),
    )
    .join("\n");

  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

const FINGERPRINT_MARKER = "advisory-fingerprint:";

/** Reads the fingerprint back out of an issue body this script wrote. */
export function readFingerprint(body: string): string | undefined {
  const match = new RegExp(
    `<!--\\s*${FINGERPRINT_MARKER}\\s*([0-9a-f]+)\\s*-->`,
  ).exec(body);
  return match?.[1];
}

export function issueTitle(advisories: readonly Advisory[]): string {
  const counts = countBySeverity(advisories);
  const parts = SEVERITIES.filter((severity) => counts[severity] > 0).map(
    (severity) => `${counts[severity]} ${severity}`,
  );

  return `${ISSUE_TITLE_PREFIX}: ${parts.join(", ")}`;
}

function table(advisories: readonly Advisory[]): string[] {
  const lines = [
    "| Severity | Package | Installed | Fixed in | Advisory |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const advisory of advisories) {
    const link =
      advisory.url === "" ? advisory.id : `[${advisory.id}](${advisory.url})`;
    lines.push(
      `| ${advisory.severity} | \`${advisory.module}\` | ` +
        `${advisory.installed.join(", ") || "—"} | ` +
        `${advisory.patchedVersions || "—"} | ${link} |`,
    );
  }

  return lines;
}

function details(advisories: readonly Advisory[]): string[] {
  const lines: string[] = [];

  for (const advisory of advisories) {
    lines.push(
      "",
      `#### ${advisory.severity}: \`${advisory.module}\` — ${advisory.title}`,
      "",
      `- Advisory: ${advisory.url === "" ? advisory.id : advisory.url}`,
      `- Vulnerable: \`${advisory.vulnerableVersions || "unknown"}\`; ` +
        `patched: \`${advisory.patchedVersions || "none published"}\``,
    );

    if (advisory.cves.length > 0) {
      lines.push(`- ${advisory.cves.join(", ")}`);
    }

    lines.push("- Reached by:");
    for (const chain of advisory.paths) lines.push(`  - \`${chain}\``);
  }

  return lines;
}

/**
 * The issue body.
 *
 * Production advisories come first and under their own heading because that is
 * the triage decision: everything in the first table is in the deployed
 * artifact, everything in the second is in somebody's terminal.
 */
export function renderIssueBody(
  result: AuditResult,
  now: Date = new Date(),
): string {
  const production = result.advisories.filter(
    (advisory) => advisory.production,
  );
  const development = result.advisories.filter(
    (advisory) => !advisory.production,
  );

  const lines = [
    `_Opened by \`.github/workflows/dependency-audit.yml\`. This issue is ` +
      `rewritten in place when the advisory set changes and closed when it ` +
      `empties; edits to the body will be overwritten._`,
    "",
    `**${result.advisories.length} advisor${
      result.advisories.length === 1 ? "y" : "ies"
    }** against ${result.totalDependencies} resolved package(s), as of ` +
      `${now.toISOString().slice(0, 10)}.`,
    "",
    `${production.length} reach the production graph; ${development.length} ` +
      "are development-only.",
  ];

  if (production.length > 0) {
    lines.push(
      "",
      "## In the production graph",
      "",
      "These resolve through a `dependencies` entry, so they are in what gets",
      "deployed.",
      "",
      ...table(production),
      "",
      "<details><summary>Detail</summary>",
      ...details(production),
      "",
      "</details>",
    );
  }

  if (development.length > 0) {
    lines.push(
      "",
      "## Development-only",
      "",
      "These resolve only through `devDependencies`. They run on a",
      "contributor's machine and in CI, which is not nothing — CI holds this",
      "repository's tokens — but they are not in the deployed artifact.",
      "",
      ...table(development),
      "",
      "<details><summary>Detail</summary>",
      ...details(development),
      "",
      "</details>",
    );
  }

  if (result.muted.length > 0) {
    lines.push(
      "",
      "## Muted",
      "",
      "`pnpm.auditConfig` in `package.json` suppresses the following, so they",
      "are absent from the tables above. A mute is invisible everywhere else",
      "in this repository; it is printed here so that it is not also invisible",
      "in the one process that exists to notice advisories.",
      "",
      ...result.muted.map((id) => `- \`${id}\``),
    );
  }

  lines.push(
    "",
    "---",
    "",
    "Reproduce with `pnpm audit` (add `--prod` for the first table only).",
    "`pnpm audit` is deliberately not a pull-request gate — see",
    "`docs/dependency-advisories.md` for why, and for what to do with this",
    "issue.",
    "",
    `<!-- ${FINGERPRINT_MARKER} ${fingerprint(result.advisories)} -->`,
  );

  return lines.join("\n");
}

/** An open issue as the client reports it. */
export interface ExistingIssue {
  number: number;
  title: string;
  body: string;
}

export type Plan =
  | { action: "create"; title: string; body: string }
  | {
      action: "update";
      number: number;
      title: string;
      body: string;
      comment: string;
    }
  | { action: "close"; number: number; comment: string }
  | { action: "noop"; reason: string };

function describeDelta(
  before: readonly string[],
  after: readonly Advisory[],
): string {
  const seen = new Set(before);
  const now = new Set(after.map((advisory) => advisory.id));

  const added = after.filter((advisory) => !seen.has(advisory.id));
  const removed = before.filter((id) => !now.has(id));

  const lines = ["The advisory set changed; the issue body above is current."];

  if (added.length > 0) {
    lines.push(
      "",
      "**New:**",
      ...added.map(
        (advisory) =>
          `- ${advisory.severity} \`${advisory.module}\` — ${advisory.id}` +
          (advisory.production ? " (production)" : ""),
      ),
    );
  }

  if (removed.length > 0) {
    lines.push(
      "",
      "**No longer reported:**",
      ...removed.map((id) => `- ${id}`),
    );
  }

  if (added.length === 0 && removed.length === 0) {
    lines.push(
      "",
      "No advisory was added or dropped — an installed version or a " +
        "production/development classification moved.",
    );
  }

  return lines.join("\n");
}

/**
 * What to do, given what the tree says and what the issue tracker holds.
 *
 * Split out from every side effect because this is the part that can be wrong
 * in a way nobody notices: a reconciler that re-opens a closed issue, or that
 * rewrites an unchanged body every Monday, still looks like it works.
 *
 * Three decisions are load-bearing.
 *
 * Only **open** issues are considered. A closed one is a decision somebody
 * made, and the correct response to an advisory coming back is a new issue
 * with a new notification, not the quiet resurrection of a thread that was
 * marked done.
 *
 * An unchanged fingerprint does **nothing at all** — no edit, no comment. The
 * body is state and the comments are the delta, and a state that has not
 * changed has nothing to say.
 *
 * A changed set rewrites the body *and* comments. The body is where a reader
 * looks; the comment is the only part that reaches somebody who is not looking,
 * because editing an issue body notifies nobody.
 */
export function plan(
  result: AuditResult,
  open: readonly ExistingIssue[],
): Plan {
  const existing = open[0];

  if (result.advisories.length === 0) {
    if (existing === undefined) {
      return { action: "noop", reason: "no advisories and no open issue" };
    }

    return {
      action: "close",
      number: existing.number,
      comment:
        "`pnpm audit` now reports no advisories against the pinned tree, so " +
        "this is resolved. A future advisory opens a new issue rather than " +
        "reopening this one.",
    };
  }

  const title = issueTitle(result.advisories);
  const body = renderIssueBody(result);

  if (existing === undefined) {
    return { action: "create", title, body };
  }

  const before = readFingerprint(existing.body);
  const after = fingerprint(result.advisories);

  if (before === after) {
    return {
      action: "noop",
      reason: `issue #${existing.number} is already current (${after})`,
    };
  }

  return {
    action: "update",
    number: existing.number,
    title,
    body,
    comment: describeDelta(identifiersIn(existing.body), result.advisories),
  };
}

/**
 * The advisory identifiers a previous body listed.
 *
 * Read back out of the rendered table rather than stored in a second marker:
 * one source of truth in the body means a hand-edited issue produces a delta
 * that describes the body as it actually reads.
 */
export function identifiersIn(body: string): string[] {
  return [
    ...new Set(
      [...body.matchAll(/\[(GHSA-[0-9a-z-]+)\]\(/g)].map(
        (match) => match[1] as string,
      ),
    ),
  ];
}

/** The issue operations this script needs. Substituted in tests. */
export interface IssueClient {
  listOpen(label: string): ExistingIssue[];
  create(input: { title: string; body: string; label: string }): number;
  update(input: { number: number; title: string; body: string }): void;
  comment(input: { number: number; body: string }): void;
  close(input: { number: number }): void;
}

/**
 * `gh`, which is on every GitHub-hosted runner and reads `GH_TOKEN` itself.
 *
 * Bodies go through `--body-file` rather than an argument. An advisory title is
 * remote text — it arrives from the registry and this repository does not
 * choose it — and the one thing that must not happen to remote text is being
 * pasted into a command line. `execFileSync` with no shell already removes the
 * interpretation, and the file removes the length limit as well: a body of
 * thirty advisories with their resolution chains is comfortably past `ARG_MAX`
 * on a runner that has a long environment.
 */
export function ghClient(repo?: string, run: Runner = runCommand): IssueClient {
  const scope = repo === undefined ? [] : ["--repo", repo];

  const gh = (args: readonly string[]): string =>
    run("gh", [...args, ...scope]);

  const withBodyFile = <T>(body: string, consume: (file: string) => T): T => {
    const directory = mkdtempSync(path.join(tmpdir(), "advisory-issue-"));
    const file = path.join(directory, "body.md");
    writeFileSync(file, body, "utf8");
    return consume(file);
  };

  return {
    listOpen(label) {
      const raw = gh([
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        label,
        "--json",
        "number,title,body",
        "--limit",
        "100",
      ]);

      const parsed: unknown = JSON.parse(raw.trim() === "" ? "[]" : raw);
      if (!Array.isArray(parsed)) {
        throw new Error("`gh issue list --json` did not return an array.");
      }

      return parsed.map((entry) => {
        const issue = entry as Partial<ExistingIssue>;
        if (typeof issue.number !== "number") {
          throw new Error("`gh issue list --json` returned an unnumbered row.");
        }
        return {
          number: issue.number,
          title: typeof issue.title === "string" ? issue.title : "",
          body: typeof issue.body === "string" ? issue.body : "",
        };
      });
    },

    create({ title, body, label }) {
      const url = withBodyFile(body, (file) =>
        gh([
          "issue",
          "create",
          "--title",
          title,
          "--body-file",
          file,
          "--label",
          label,
        ]),
      );

      // `gh issue create` prints the issue's URL and nothing else.
      const match = /\/issues\/(\d+)\s*$/.exec(url.trim());
      if (match === null) {
        throw new Error(`could not read an issue number out of: ${url.trim()}`);
      }
      return Number(match[1]);
    },

    update({ number, title, body }) {
      withBodyFile(body, (file) =>
        gh([
          "issue",
          "edit",
          String(number),
          "--title",
          title,
          "--body-file",
          file,
        ]),
      );
    },

    comment({ number, body }) {
      withBodyFile(body, (file) =>
        gh(["issue", "comment", String(number), "--body-file", file]),
      );
    },

    close({ number }) {
      gh(["issue", "close", String(number), "--reason", "completed"]);
    },
  };
}

/** Carries out a plan. Returns the line printed to the job log. */
export function apply(chosen: Plan, client: IssueClient): string {
  switch (chosen.action) {
    case "noop":
      return `Nothing to do — ${chosen.reason}.`;

    case "create": {
      const number = client.create({
        title: chosen.title,
        body: chosen.body,
        label: ADVISORY_LABEL,
      });
      return `Opened #${number}: ${chosen.title}`;
    }

    case "update":
      // Body before comment: a notification that arrives ahead of the state it
      // describes sends its reader to a stale table.
      client.update({
        number: chosen.number,
        title: chosen.title,
        body: chosen.body,
      });
      client.comment({ number: chosen.number, body: chosen.comment });
      return `Updated #${chosen.number}: ${chosen.title}`;

    case "close":
      client.comment({ number: chosen.number, body: chosen.comment });
      client.close({ number: chosen.number });
      return `Closed #${chosen.number} — the tree is clean.`;
  }
}

export function main(argv: readonly string[]): number {
  const dryRun = argv.includes("--dry-run");
  const result = audit();

  if (dryRun) {
    // The tracker is deliberately not read: a dry run is for seeing what this
    // repository's tree produces, and it must work without a token. What it
    // prints is therefore the body, not the plan — the plan depends on an
    // issue that may already exist and is `plan()`'s own tested business.
    console.log(
      `Dry run — ${result.advisories.length} advisor` +
        `${result.advisories.length === 1 ? "y" : "ies"} ` +
        `(${result.advisories.filter((a) => a.production).length} in the ` +
        `production graph), fingerprint ` +
        `${fingerprint(result.advisories)}. Nothing was read from or ` +
        "written to the issue tracker.",
    );

    if (result.advisories.length > 0) {
      console.log(`\n--- ${issueTitle(result.advisories)} ---\n`);
      console.log(renderIssueBody(result));
    }
    return 0;
  }

  const client = ghClient(process.env["GITHUB_REPOSITORY"]);
  console.log(apply(plan(result, client.listOpen(ADVISORY_LABEL)), client));
  return 0;
}

/* c8 ignore start -- CLI entry; the logic above is what the tests exercise. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // Thrown, not swallowed: this job's only dangerous outcome is looking like
    // a clean tree when it could not look at the tree at all.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
