import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SCANNED_DIRS } from "./assert-action-pins";
import { ADVISORY_LABEL, AUDIT_ARGS } from "./audit-dependencies";
import {
  AUDIT_SCRIPT,
  AUDIT_WORKFLOW,
  CI_WORKFLOW,
  MUTING_FLAGS,
  REQUIRED_PERMISSIONS,
  auditArgFindings,
  check,
  topLevelBlock,
} from "./assert-advisory-audit";

const REPO = process.cwd();

/**
 * A copy of the real workflows, broken in one specific way.
 *
 * Copying rather than writing fixtures is what makes each case below a
 * statement about *this* repository: the gate passes on the tree as it stands
 * and fails with one line changed. A hand-written fixture would only prove
 * that a regex matches a string somebody wrote to make it match.
 */
function withBrokenTree(
  edits: { file: string; edit: (source: string) => string }[],
): string {
  const root = mkdtempSync(path.join(tmpdir(), "advisory-audit-gate-"));

  for (const directory of SCANNED_DIRS) {
    cpSync(path.join(REPO, directory), path.join(root, directory), {
      recursive: true,
    });
  }
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  cpSync(path.join(REPO, AUDIT_SCRIPT), path.join(root, AUDIT_SCRIPT));

  for (const { file, edit } of edits) {
    const target = path.join(root, file);
    const before = readFileSync(target, "utf8");
    const after = edit(before);
    if (after === before) {
      throw new Error(`the edit to ${file} changed nothing`);
    }
    writeFileSync(target, after, "utf8");
  }

  return root;
}

function rulesFiring(
  edits: { file: string; edit: (source: string) => string }[],
): string[] {
  return [
    ...new Set(check(withBrokenTree(edits)).map((finding) => finding.rule)),
  ];
}

/** Drops the whole `permissions:` block, or rewrites one line of it. */
function editPermissions(replacement: string) {
  return (source: string): string =>
    source.replace(/^permissions:\n(?:[ \t]+.*\n)+/m, replacement);
}

describe("assert-advisory-audit", () => {
  it("passes on this repository", () => {
    expect(check(REPO)).toEqual([]);
  });

  it("reports the workflow as missing rather than passing without it", () => {
    // The whole point: an absent audit and a clean tree look identical, so
    // the gate has to be the thing that can tell them apart.
    const root = mkdtempSync(path.join(tmpdir(), "advisory-audit-empty-"));
    const findings = check(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("A1");
    expect(findings[0]?.message).toContain("indistinguishable");
  });

  describe("A1 — it has to run on its own", () => {
    it("fails a workflow with no `schedule:` trigger", () => {
      expect(
        rulesFiring([
          {
            file: AUDIT_WORKFLOW,
            edit: (source) =>
              source.replace(/^ {2}schedule:\n(?: {4}.*\n)+/m, ""),
          },
        ]),
      ).toEqual(["A1"]);
    });

    it("fails a workflow with no triggers at all", () => {
      expect(
        rulesFiring([
          {
            file: AUDIT_WORKFLOW,
            edit: (source) =>
              source.replace(/^on:\n(?: {2}.*\n| {4}.*\n)+/m, "on:\n"),
          },
        ]),
      ).toContain("A1");
    });
  });

  describe("A2 — and never on a pull request", () => {
    for (const trigger of ["pull_request", "pull_request_target", "push"]) {
      it(`fails a \`${trigger}:\` trigger`, () => {
        expect(
          rulesFiring([
            {
              file: AUDIT_WORKFLOW,
              edit: (source) =>
                source.replace(
                  /^ {2}workflow_dispatch:$/m,
                  `  ${trigger}:\n    branches: [main]`,
                ),
            },
          ]),
        ).toEqual(["A2"]);
      });
    }
  });

  describe("A3 — and is not smuggled back in elsewhere", () => {
    it("fails a `pnpm audit` step added to the pull-request workflow", () => {
      expect(
        rulesFiring([
          {
            file: CI_WORKFLOW,
            edit: (source) =>
              source.replace(
                /^ {6}- name: Lint$/m,
                "      - name: Audit\n        run: pnpm audit --audit-level high\n\n      - name: Lint",
              ),
          },
        ]),
      ).toEqual(["A3"]);
    });

    it("fails it in a shipped template too, which somebody copies", () => {
      expect(
        rulesFiring([
          {
            file: "workflow-templates/ci.yml",
            edit: (source) =>
              `${source}\n# placeholder\n        run: pnpm audit\n`,
          },
        ]),
      ).toEqual(["A3"]);
    });

    it("does not read a commented-out mention as a violation", () => {
      // This repository's own workflows explain in prose why `pnpm audit` is
      // not a gate; a rule that cannot be documented is a rule nobody keeps.
      const root = withBrokenTree([
        {
          file: CI_WORKFLOW,
          edit: (source) => `# Deliberately no \`pnpm audit\` here.\n${source}`,
        },
      ]);

      expect(check(root)).toEqual([]);
    });
  });

  describe("A4 — least privilege on a job nobody is watching", () => {
    it("fails a workflow that declares no permissions", () => {
      expect(
        rulesFiring([{ file: AUDIT_WORKFLOW, edit: editPermissions("") }]),
      ).toEqual(["A4"]);
    });

    it("fails a widened scope", () => {
      expect(
        rulesFiring([
          {
            file: AUDIT_WORKFLOW,
            edit: editPermissions(
              "permissions:\n  contents: write\n  issues: write\n",
            ),
          },
        ]),
      ).toEqual(["A4"]);
    });

    it("fails an extra scope nobody needs", () => {
      const findings = check(
        withBrokenTree([
          {
            file: AUDIT_WORKFLOW,
            edit: editPermissions(
              "permissions:\n  contents: read\n  issues: write\n  packages: write\n",
            ),
          },
        ]),
      );

      expect(findings.map((finding) => finding.rule)).toEqual(["A4"]);
      expect(findings[0]?.message).toContain("packages: write");
    });

    it("fails a missing scope", () => {
      expect(
        rulesFiring([
          {
            file: AUDIT_WORKFLOW,
            edit: editPermissions("permissions:\n  contents: read\n"),
          },
        ]),
      ).toEqual(["A4"]);
    });

    it("asks for exactly the two the job uses", () => {
      expect(REQUIRED_PERMISSIONS).toEqual([
        ["contents", "read"],
        ["issues", "write"],
      ]);
    });
  });

  describe("A5 — green with findings, never green without looking", () => {
    it("fails `continue-on-error: true`", () => {
      expect(
        rulesFiring([
          {
            file: AUDIT_WORKFLOW,
            edit: (source) =>
              source.replace(
                /^ {6}- name: Audit the pinned tree and reconcile the issue$/m,
                "      - name: Audit the pinned tree and reconcile the issue\n        continue-on-error: true",
              ),
          },
        ]),
      ).toEqual(["A5"]);
    });

    it("fails a `run:` that swallows its exit code", () => {
      expect(
        rulesFiring([
          {
            file: AUDIT_WORKFLOW,
            edit: (source) =>
              source.replace(
                /(run: pnpm exec tsx scripts\/audit-dependencies\.ts)$/m,
                "$1 || true",
              ),
          },
        ]),
      ).toEqual(["A5"]);
    });
  });

  describe("A6 — nothing narrows what the audit reports", () => {
    it("passes the arguments this script actually runs", () => {
      expect(auditArgFindings()).toEqual([]);
      expect(AUDIT_ARGS).toContain("--json");
    });

    for (const flag of MUTING_FLAGS) {
      it(`fails \`${flag}\` on the full audit`, () => {
        const findings = auditArgFindings(
          ["audit", flag, "--json"],
          ["audit", "--prod", "--json"],
        );

        expect(findings.map((finding) => finding.rule)).toEqual(["A6"]);
        expect(findings[0]?.message).toContain(flag);
      });

      it(`fails \`${flag}=…\` on the production audit`, () => {
        expect(
          auditArgFindings(
            ["audit", "--json"],
            ["audit", "--prod", `${flag}=high`, "--json"],
          ),
        ).toHaveLength(1);
      });
    }

    it("fails an audit that stopped asking for JSON", () => {
      expect(
        auditArgFindings(["audit"], ["audit", "--prod", "--json"]),
      ).toHaveLength(1);
    });

    it("fails the loss of the production comparison", () => {
      const findings = auditArgFindings(
        ["audit", "--json"],
        ["audit", "--json"],
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("--prod");
    });
  });

  describe("A7 — the workflow runs the tested module", () => {
    it("fails a workflow that no longer runs the script", () => {
      expect(
        rulesFiring([
          {
            file: AUDIT_WORKFLOW,
            edit: (source) =>
              source.replace(
                /run: pnpm exec tsx scripts\/audit-dependencies\.ts/,
                "run: pnpm audit --json > audit.json",
              ),
          },
        ]),
      ).toEqual(["A7"]);
    });

    it("fails a `--dry-run` left behind", () => {
      expect(
        rulesFiring([
          {
            file: AUDIT_WORKFLOW,
            edit: (source) =>
              source.replace(
                /(run: pnpm exec tsx scripts\/audit-dependencies\.ts)$/m,
                "$1 --dry-run",
              ),
          },
        ]),
      ).toEqual(["A7"]);
    });

    it("fails a workflow whose script is gone", () => {
      const root = withBrokenTree([]);
      // `withBrokenTree` copies the script; removing it is the regression.
      const findings = check(
        (() => {
          const stripped = mkdtempSync(
            path.join(tmpdir(), "advisory-noscript-"),
          );
          for (const directory of SCANNED_DIRS) {
            cpSync(path.join(root, directory), path.join(stripped, directory), {
              recursive: true,
            });
          }
          return stripped;
        })(),
      );

      expect(findings.map((finding) => finding.rule)).toEqual(["A7"]);
    });
  });

  describe("A8 — one label, spelled the same on both sides", () => {
    it("fails a workflow that never creates the label", () => {
      // `gh issue create --label` fails against a label that does not exist,
      // so the first run would die rather than file anything.
      expect(
        rulesFiring([
          {
            file: AUDIT_WORKFLOW,
            edit: (source) =>
              source.replace(
                /^ {10}gh label create .*\n(?: {12}.*\n)+/m,
                "          true\n",
              ),
          },
        ]),
      ).toEqual(["A8"]);
    });

    it("fails a label renamed on the workflow's side only", () => {
      const findings = check(
        withBrokenTree([
          {
            file: AUDIT_WORKFLOW,
            edit: (source) =>
              source.replace(
                `gh label create ${ADVISORY_LABEL}`,
                "gh label create security-advisory",
              ),
          },
        ]),
      );

      expect(findings.map((finding) => finding.rule)).toEqual(["A8"]);
      expect(findings[0]?.message).toContain(ADVISORY_LABEL);
    });
  });

  describe("topLevelBlock", () => {
    it("takes a key's block and stops at the next top-level key", () => {
      const lines = [
        "on:",
        "  schedule:",
        "    - cron: 17 7 * * 1",
        "",
        "permissions:",
        "  contents: read",
      ].map((text, index) => ({ line: index + 1, text }));

      expect(topLevelBlock(lines, "on").map((entry) => entry.text)).toEqual([
        "on:",
        "  schedule:",
        "    - cron: 17 7 * * 1",
      ]);
    });

    it("is empty for a key that is not there", () => {
      expect(topLevelBlock([], "permissions")).toEqual([]);
    });
  });
});
