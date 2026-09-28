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

import {
  check,
  collectUses,
  workflowFiles,
  DEPENDABOT_FILE,
  SCANNED_DIRS,
} from "./assert-action-pins";

const REPO = process.cwd();
const WORKFLOW = ".github/workflows/ci.yml";
const TEMPLATE = "workflow-templates/ci.yml";

/**
 * A copy of the real workflows, broken in one specific way.
 *
 * Copying the tree rather than writing fixtures is what makes each case below a
 * statement about *this* repository: the gate has to pass on it as it stands
 * and fail with one line changed. A hand-written fixture would only prove a
 * regex matches a string somebody wrote to make it match.
 */
function withBrokenTree(
  edits: { file: string; edit: (source: string) => string }[],
): string {
  const root = mkdtempSync(path.join(tmpdir(), "action-pins-gate-"));

  for (const directory of SCANNED_DIRS) {
    cpSync(path.join(REPO, directory), path.join(root, directory), {
      recursive: true,
    });
  }
  mkdirSync(path.join(root, ".github"), { recursive: true });
  cpSync(path.join(REPO, DEPENDABOT_FILE), path.join(root, DEPENDABOT_FILE));

  for (const { file, edit } of edits) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
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

/** Rewrites the first `uses:` line whose action matches. */
function repin(action: string, replacement: string) {
  return (source: string): string =>
    source.replace(
      new RegExp(`(^[ \\t]*-?[ \\t]*uses:[ \\t]*)${action}@\\S+.*$`, "m"),
      `$1${replacement}`,
    );
}

describe("assert-action-pins", () => {
  it("passes on this repository", () => {
    expect(check(REPO)).toEqual([]);
  });

  it("finds a `uses:` in every workflow file, in both directories", () => {
    const files = workflowFiles(REPO).map((entry) => entry.file);
    expect(files).toContain(WORKFLOW);
    expect(files).toContain(TEMPLATE);

    const sites = collectUses(REPO);
    expect(sites.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(sites.some((site) => site.file === file)).toBe(true);
    }
  });

  it("reads the version out of the trailing comment, not out of the ref", () => {
    const checkout = collectUses(REPO).find(
      (site) => site.action === "actions/checkout",
    );
    expect(checkout).toBeDefined();
    expect(checkout?.reference).toMatch(/^[0-9a-f]{40}$/);
    expect(checkout?.comment).toMatch(/^v\d/);
  });

  it("P1 — fails an action put back on a major tag", () => {
    expect(
      rulesFiring([
        {
          file: WORKFLOW,
          edit: repin("actions/checkout", "actions/checkout@v4"),
        },
      ]),
    ).toContain("P1");
  });

  it("P1 — fails a short SHA, which git will happily resolve and GitHub will not", () => {
    expect(
      rulesFiring([
        {
          file: WORKFLOW,
          edit: repin("actions/checkout", "actions/checkout@11d5960 # v4.4.0"),
        },
      ]),
    ).toContain("P1");
  });

  it("P1 — fails a digest copied out of a UI with uppercase hex", () => {
    expect(
      rulesFiring([
        {
          file: WORKFLOW,
          edit: repin(
            "actions/checkout",
            "actions/checkout@11D5960A326750D5838078E36CF38B85AF677262 # v4.4.0",
          ),
        },
      ]),
    ).toContain("P1");
  });

  it("P1 — still fires when the tag is hedged about in a trailing comment", () => {
    // The regression this exists for: an earlier `USES` pattern required the
    // line to end after a one-word comment, so this line matched nothing and
    // the unpinned action was never reported. A gate that fails open on the
    // line somebody was writing a note about is worse than no gate.
    expect(
      rulesFiring([
        {
          file: WORKFLOW,
          edit: repin(
            "actions/checkout",
            "actions/checkout@v4 # TODO: pin this properly",
          ),
        },
      ]),
    ).toContain("P1");
  });

  it("P2 — judges the first token of the comment, not the prose after it", () => {
    const findings = check(
      withBrokenTree([
        {
          file: WORKFLOW,
          edit: repin(
            "actions/checkout",
            "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0 (held back deliberately)",
          ),
        },
      ]),
    );
    // `v4.4.0` satisfies P2, and P3 agrees with the other sites, because both
    // rules read the version token rather than the whole line. Prose after the
    // version is a human's to write; Dependabot rewrites the token.
    expect(findings).toEqual([]);
  });

  it("P1 — fails a container image named by a re-pushable tag", () => {
    expect(
      rulesFiring([
        {
          file: WORKFLOW,
          edit: repin("actions/checkout", "docker://alpine:3.20"),
        },
      ]),
    ).toContain("P1");
  });

  it("P1 — accepts a container image named by its sha256 digest", () => {
    const digest = "a".repeat(64);
    const findings = check(
      withBrokenTree([
        {
          file: WORKFLOW,
          edit: repin("actions/checkout", `docker://alpine@sha256:${digest}`),
        },
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("P1 — leaves a local action alone, because it is already in this commit", () => {
    const findings = check(
      withBrokenTree([
        {
          file: WORKFLOW,
          edit: repin("actions/checkout", "./.github/actions/checkout"),
        },
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("P2 — fails a digest with the version comment stripped", () => {
    expect(
      rulesFiring([
        {
          file: WORKFLOW,
          edit: repin(
            "actions/checkout",
            "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
          ),
        },
      ]),
    ).toContain("P2");
  });

  it("P2 — fails a comment Dependabot cannot parse as a version", () => {
    expect(
      rulesFiring([
        {
          file: WORKFLOW,
          edit: repin(
            "actions/checkout",
            "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # latest",
          ),
        },
      ]),
    ).toContain("P2");
  });

  it("P3 — fails the template left behind at an older digest", () => {
    const rules = rulesFiring([
      {
        file: TEMPLATE,
        edit: repin(
          "actions/checkout",
          "actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955 # v4.3.0",
        ),
      },
    ]);
    expect(rules).toContain("P3");
  });

  it("P3 — fails a version comment edited without its digest", () => {
    const rules = rulesFiring([
      {
        file: TEMPLATE,
        edit: repin(
          "actions/checkout",
          "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.3.0",
        ),
      },
    ]);
    expect(rules).toContain("P3");
    expect(rules).not.toContain("P1");
  });

  it("P4 — fails when the github-actions ecosystem is dropped", () => {
    expect(
      rulesFiring([
        {
          file: DEPENDABOT_FILE,
          edit: (source) =>
            source.replace(
              /^\s*-\s*package-ecosystem:\s*github-actions\s*$/m,
              "  - package-ecosystem: docker",
            ),
        },
      ]),
    ).toContain("P4");
  });

  it("P4 — fails an `ignore` added under the github-actions entry", () => {
    expect(
      rulesFiring([
        {
          file: DEPENDABOT_FILE,
          edit: (source) =>
            `${source.trimEnd()}\n    ignore:\n      - dependency-name: actions/checkout\n`,
        },
      ]),
    ).toContain("P4");
  });

  it("P4 — does not read the npm entry's `ignore` as the actions entry's", () => {
    // The npm block already has one, above the github-actions entry. If the
    // block scan leaked upward this case would fail on the unedited tree, so
    // the assertion is that the only finding is the one the edit introduced.
    const rules = rulesFiring([
      {
        file: WORKFLOW,
        edit: repin("actions/checkout", "actions/checkout@v4"),
      },
    ]);
    expect(rules).toEqual(["P1"]);
  });

  it("skips a commented-out `uses:`, so the gates can be documented", () => {
    const findings = check(
      withBrokenTree([
        {
          file: WORKFLOW,
          edit: (source) =>
            source.replace(
              /^(\s*)- uses: actions\/checkout@/m,
              "$1# - uses: actions/checkout@v4 was the old form\n$1- uses: actions/checkout@",
            ),
        },
      ]),
    );
    expect(findings).toEqual([]);
  });
});
