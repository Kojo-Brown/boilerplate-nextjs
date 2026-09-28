/**
 * Asserts that every GitHub Action this repository runs is pinned to a commit
 * digest, and that the pins stay maintained rather than merely present.
 *
 * A tag is a pointer, not a version. `actions/checkout@v4` names whatever
 * commit the `v4` ref happens to point at when the runner resolves it, and the
 * publisher can move that ref at any time — a compromised maintainer account
 * retags `v4` and every workflow in the world runs the new code on its next
 * push, with this repository's `GITHUB_TOKEN` and whatever secrets the job is
 * scoped to. That is not hypothetical: it is what `tj-actions/changed-files`
 * did to tens of thousands of repositories in March 2025, by moving tags that
 * had already been reviewed. A digest is the one reference GitHub cannot
 * re-point.
 *
 * The existing A08 rule in `scripts/assert-owasp-checklist.ts` fails a `@main`
 * and nothing else, so `@v4` passed it — which is the honest state this gate
 * replaces: a moving reference that merely moves less often than a branch.
 *
 * Pinning surfaced something the tags were hiding. `pnpm/action-setup@v4` is an
 * *annotated* tag, so `refs/tags/v4` resolves to a tag object rather than a
 * commit, and the commit underneath it is `v4.3.0`'s — while `v4.4.0` has
 * existed for months. Every CI run here has been on v4.3.0 while the file said
 * `v4`. The pin below records the commit that was actually running; changing it
 * is now a reviewable line rather than somebody else's `git push --force`.
 *
 *   P1  Every `uses:` naming a remote action is pinned to a 40-character
 *       lowercase hex commit SHA. A tag, a branch, or a short SHA fails.
 *       `docker://` images must carry an `@sha256:` digest for the same reason.
 *       A local reference (`./…`) is code in this commit already.
 *
 *   P2  Every pin carries a trailing `# <version>` comment naming the release
 *       it came from. This is not decoration: Dependabot parses that comment to
 *       decide what the digest means and rewrites it alongside the SHA, and
 *       without one a reviewer has forty hex characters and no way to tell an
 *       upgrade from a substitution.
 *
 *   P3  One action, one pin. Every file scanned must agree on both the digest
 *       and the version comment for a given action. This is the rule that keeps
 *       `workflow-templates/` honest: Dependabot's `github-actions` ecosystem
 *       only ever looks inside `.github/workflows/`, so a template it cannot
 *       see would otherwise sit at whatever digest it was written with while
 *       the real workflow moved on — and a template is the file somebody copies
 *       into a new repository.
 *
 *   P4  `.github/dependabot.yml` keeps a `github-actions` entry, and does not
 *       `ignore` anything in it. Pinning without updates is how a repository
 *       ends up running a two-year-old action with a known advisory, which is
 *       the failure mode that makes people distrust digest pinning in the first
 *       place.
 *
 * What this gate cannot check is that a digest is a real commit on the action's
 * own repository — that needs the network, and a CI gate that fails when
 * github.com is slow is a gate people learn to re-run rather than read. The
 * digests were verified by fetching each one at the commit that introduced
 * them; a wrong one fails the workflow itself, loudly, on the next run.
 *
 * Usage: tsx scripts/assert-action-pins.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export interface Finding {
  rule: "P1" | "P2" | "P3" | "P4";
  file: string;
  message: string;
}

export const DEPENDABOT_FILE = ".github/dependabot.yml";

/**
 * Where a `uses:` line can live.
 *
 * `.github/workflows` is what GitHub runs; `workflow-templates` is what this
 * repository hands to other people, which makes a rotten pin there worse rather
 * than better. Both are flat by convention, so there is nothing to recurse.
 */
export const SCANNED_DIRS: readonly string[] = [
  ".github/workflows",
  "workflow-templates",
];

/**
 * A `uses:` line, split into its target and whatever trails it.
 *
 * The trailing group is `.*` rather than a comment shape on purpose. An earlier
 * version required the line to *end* after an optional one-word comment, which
 * meant `uses: actions/checkout@v4 # v4, pinned later` matched nothing at all
 * and the unpinned action went unreported — a gate that fails open on the exact
 * line somebody was hedging about. Anything after the target is now captured and
 * interpreted here.
 */
const USES = /^\s*-?\s*uses:\s*(\S+)\s*(.*)$/;

/** A commit digest: git's full object name, lowercase, as GitHub writes it. */
const DIGEST = /^[0-9a-f]{40}$/;

/** `v1`, `v4.4.0`, `4.4.0` — what Dependabot is able to rewrite. */
const VERSION_COMMENT = /^v?\d+(?:\.\d+)*$/;

export interface UseSite {
  /** `owner/repo` or `owner/repo/path`, with the ref stripped. */
  action: string;
  /** Whatever followed the `@`. */
  reference: string | undefined;
  /** The trailing `# …` token, if the line carried one. */
  comment: string | undefined;
  file: string;
  line: number;
  raw: string;
}

export function workflowFiles(root: string): { file: string; text: string }[] {
  const files: { file: string; text: string }[] = [];

  for (const directory of SCANNED_DIRS) {
    const absolute = path.join(root, directory);
    if (!existsSync(absolute)) continue;

    for (const name of readdirSync(absolute).sort()) {
      if (!/\.ya?ml$/.test(name)) continue;
      files.push({
        file: `${directory}/${name}`,
        text: readFileSync(path.join(absolute, name), "utf8"),
      });
    }
  }

  return files;
}

/**
 * Every `uses:` in the scanned files.
 *
 * Commented-out lines are skipped: this file's own header quotes `@v4` while
 * explaining why it is gone, and a gate that reads its own prose as a violation
 * is a gate nobody can document.
 */
export function collectUses(root: string): UseSite[] {
  const sites: UseSite[] = [];

  for (const { file, text } of workflowFiles(root)) {
    for (const [index, line] of text.split("\n").entries()) {
      if (/^\s*#/.test(line)) continue;

      const match = USES.exec(line);
      if (!match) continue;

      // YAML lets the scalar be quoted; the quotes are not part of the ref.
      const target = (match[1] as string).replace(/^["']|["']$/g, "");
      const at = target.lastIndexOf("@");

      // Dependabot reads the first token of the comment as the version and
      // leaves any prose after it alone, so that is what P2 is judged on.
      const trailing = (match[2] as string).trim();
      const comment = trailing.startsWith("#")
        ? (trailing.slice(1).trim().split(/\s+/)[0] ?? "")
        : undefined;

      sites.push({
        action: at === -1 ? target : target.slice(0, at),
        reference: at === -1 ? undefined : target.slice(at + 1),
        comment,
        file,
        line: index + 1,
        raw: target,
      });
    }
  }

  return sites;
}

/** A reference to code that is already in this commit needs no pin. */
function isLocal(action: string): boolean {
  return action.startsWith("./") || action.startsWith("../");
}

function checkPins(sites: readonly UseSite[], findings: Finding[]): void {
  for (const site of sites) {
    const where = `${site.file}:${site.line}`;
    if (isLocal(site.action)) continue;

    if (site.action.startsWith("docker://")) {
      if (!/@sha256:[0-9a-f]{64}$/.test(site.raw)) {
        findings.push({
          rule: "P1",
          file: where,
          message:
            `\`${site.raw}\` names a container image by tag. An image tag is ` +
            "re-pushable, so the bytes that run are whoever's pushed last — " +
            "use the `@sha256:` digest.",
        });
      }
      continue;
    }

    if (site.reference === undefined || !DIGEST.test(site.reference)) {
      findings.push({
        rule: "P1",
        file: where,
        message:
          `\`${site.raw}\` is pinned to \`${site.reference ?? "nothing"}\`, ` +
          "which its publisher can re-point at any commit. An action runs " +
          "with this repository's token; pin the 40-character commit digest " +
          "and put the version in a trailing comment.",
      });
      continue;
    }

    if (site.comment === undefined) {
      findings.push({
        rule: "P2",
        file: where,
        message:
          `\`${site.action}\` is pinned to a digest with no \`# <version>\` ` +
          "comment. Dependabot reads that comment to name what the digest is " +
          "and rewrites it on a bump; without one the line is forty hex " +
          "characters no reviewer can place.",
      });
      continue;
    }

    if (!VERSION_COMMENT.test(site.comment)) {
      findings.push({
        rule: "P2",
        file: where,
        message:
          `\`${site.action}\` is annotated \`# ${site.comment}\`, which is ` +
          "not a version Dependabot can parse. Use the release tag, e.g. " +
          "`# v4.4.0`.",
      });
    }
  }
}

/**
 * P3 — the same action, pinned two ways, in one repository.
 *
 * Reported against every site after the first, and against the digest and the
 * comment separately: a template left behind at an older digest and a template
 * whose comment was edited without its digest are different mistakes, and the
 * second is the one that makes a correct pin look wrong.
 */
function checkAgreement(sites: readonly UseSite[], findings: Finding[]): void {
  const first = new Map<string, UseSite>();

  for (const site of sites) {
    if (isLocal(site.action) || site.reference === undefined) continue;
    if (!DIGEST.test(site.reference)) continue;

    const seen = first.get(site.action);
    if (seen === undefined) {
      first.set(site.action, site);
      continue;
    }

    const at = `${seen.file}:${seen.line}`;

    if (seen.reference !== site.reference) {
      findings.push({
        rule: "P3",
        file: `${site.file}:${site.line}`,
        message:
          `\`${site.action}\` is pinned to \`${site.reference}\` here and to ` +
          `\`${seen.reference}\` at ${at}. Dependabot only updates ` +
          "`.github/workflows`, so a second pin elsewhere is one nothing " +
          "maintains — they have to move together.",
      });
      continue;
    }

    if (seen.comment !== site.comment) {
      findings.push({
        rule: "P3",
        file: `${site.file}:${site.line}`,
        message:
          `\`${site.action}\` carries \`# ${site.comment ?? "no comment"}\` ` +
          `here and \`# ${seen.comment ?? "no comment"}\` at ${at}, on the ` +
          "same digest. One of the two is describing a release it is not.",
      });
    }
  }
}

/**
 * P4 — the updates that make a pin a decision rather than a freeze.
 *
 * Read as text rather than parsed: the only questions are whether the ecosystem
 * is declared and whether anything in that block is ignored, and both are
 * visible in the lines themselves. `assert-owasp-checklist.ts` already fails a
 * dependabot file that drops an ecosystem entirely; this adds the `ignore`,
 * which is the quieter way to stop the updates.
 */
function checkDependabot(root: string, findings: Finding[]): void {
  const absolute = path.join(root, DEPENDABOT_FILE);

  if (!existsSync(absolute)) {
    findings.push({
      rule: "P4",
      file: DEPENDABOT_FILE,
      message:
        "is missing. A digest never moves on its own, so pinning without " +
        "Dependabot is a commitment to run today's action forever.",
    });
    return;
  }

  const lines = readFileSync(absolute, "utf8").split("\n");
  const start = lines.findIndex((line) =>
    /^\s*-?\s*package-ecosystem:\s*["']?github-actions["']?\s*$/.test(line),
  );

  if (start === -1) {
    findings.push({
      rule: "P4",
      file: DEPENDABOT_FILE,
      message:
        "declares no `github-actions` ecosystem, so nothing proposes a new " +
        "digest. A pinned action with no update path is a pinned advisory.",
    });
    return;
  }

  // The entry runs to the next `- package-ecosystem:` at the same level, or to
  // the end of the file.
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) =>
    /^\s*-\s*package-ecosystem:/.test(line),
  );
  const block = next === -1 ? rest : rest.slice(0, next);

  const ignored = block.findIndex((line) => /^\s*ignore:\s*$/.test(line));
  if (ignored !== -1) {
    findings.push({
      rule: "P4",
      file: `${DEPENDABOT_FILE}:${start + 2 + ignored}`,
      message:
        "ignores updates inside the `github-actions` entry. An ignored " +
        "action keeps the digest it was pinned with and stops being told " +
        "about advisories against it, which is strictly worse than the tag " +
        "it replaced.",
    });
  }
}

export function check(root: string): Finding[] {
  const findings: Finding[] = [];
  const sites = collectUses(root);

  checkPins(sites, findings);
  checkAgreement(sites, findings);
  checkDependabot(root, findings);

  return findings;
}

export function main(root: string): number {
  const findings = check(root);

  if (findings.length > 0) {
    console.error("Action pinning gate failed:\n");
    for (const finding of findings) {
      console.error(`${finding.file}  [${finding.rule}] ${finding.message}`);
    }
    console.error(`\n${findings.length} finding(s).`);
    return 1;
  }

  const sites = collectUses(root).filter((site) => !isLocal(site.action));
  const actions = new Set(sites.map((site) => site.action));

  console.log(
    `Action pins OK — ${sites.length} \`uses:\` across ` +
      `${workflowFiles(root).length} file(s), ${actions.size} distinct ` +
      "action(s), every one on a commit digest with a version comment, no " +
      "two pins disagreeing, and Dependabot still updating them.",
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
