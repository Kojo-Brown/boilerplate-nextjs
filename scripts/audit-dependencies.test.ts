import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ADVISORY_LABEL,
  ISSUE_TITLE_PREFIX,
  apply,
  audit,
  compareAdvisories,
  countBySeverity,
  fingerprint,
  ghClient,
  identifiersIn,
  issueTitle,
  plan,
  readFingerprint,
  renderIssueBody,
  type Advisory,
  type AuditResult,
  type ExistingIssue,
  type IssueClient,
  type Plan,
  type Runner,
} from "./audit-dependencies";

/**
 * One advisory in the registry's shape, not ours.
 *
 * The parser's job is to be suspicious of this object — it is a remote
 * service's response — so the fixtures are written in the wire format and the
 * assertions are about what comes out the other side.
 */
function rawAdvisory(overrides: Record<string, unknown> = {}) {
  return {
    id: 1117015,
    github_advisory_id: "GHSA-qx2v-qp2m-jg93",
    severity: "moderate",
    module_name: "postcss",
    title: "PostCSS has XSS via unescaped </style>",
    url: "https://github.com/advisories/GHSA-qx2v-qp2m-jg93",
    vulnerable_versions: "<8.5.10",
    patched_versions: ">=8.5.10",
    cves: ["CVE-2026-41305"],
    findings: [{ version: "8.4.31", paths: [".>next>postcss"] }],
    ...overrides,
  };
}

function report(
  advisories: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    actions: [],
    advisories,
    muted: [],
    metadata: { totalDependencies: 824 },
    ...extra,
  });
}

/** A runner that answers the full audit and the `--prod` one differently. */
function runnerFor(full: string, prod: string): Runner {
  return (command, args) => {
    expect(command).toBe("pnpm");
    return args.includes("--prod") ? prod : full;
  };
}

function advisory(overrides: Partial<Advisory> = {}): Advisory {
  return {
    id: "GHSA-aaaa-bbbb-cccc",
    severity: "high",
    module: "left-pad",
    title: "left-pad pads left",
    url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
    vulnerableVersions: "<2.0.0",
    patchedVersions: ">=2.0.0",
    installed: ["1.0.0"],
    paths: [".>left-pad"],
    cves: [],
    production: true,
    ...overrides,
  };
}

function result(
  advisories: Advisory[],
  extra: Partial<AuditResult> = {},
): AuditResult {
  return { advisories, muted: [], totalDependencies: 824, ...extra };
}

/** Records every call, so ordering is assertable and nothing reaches `gh`. */
function fakeClient(open: ExistingIssue[] = []) {
  const calls: string[] = [];

  const client: IssueClient = {
    listOpen(label) {
      calls.push(`listOpen(${label})`);
      return open;
    },
    create({ title, label }) {
      calls.push(`create(${title}, ${label})`);
      return 42;
    },
    update({ number, title }) {
      calls.push(`update(#${number}, ${title})`);
    },
    comment({ number }) {
      calls.push(`comment(#${number})`);
    },
    close({ number }) {
      calls.push(`close(#${number})`);
    },
  };

  return { client, calls };
}

describe("audit", () => {
  it("merges the production audit in as a flag on the full one", () => {
    const full = report({
      "1": rawAdvisory(),
      "2": rawAdvisory({
        id: 2,
        github_advisory_id: "GHSA-dev1-dev1-dev1",
        module_name: "@faker-js/faker",
        severity: "high",
      }),
    });
    // The production run sees the first and not the second.
    const prod = report({ "1": rawAdvisory() });

    const { advisories } = audit(runnerFor(full, prod));

    expect(advisories.map((a) => [a.module, a.production])).toEqual([
      ["@faker-js/faker", false],
      ["postcss", true],
    ]);
  });

  it("keeps the full audit's set even if the production run reports more", () => {
    // The two runs disagreeing about the tree is a bug rather than a finding,
    // and taking the union would silently paper over it.
    const full = report({ "1": rawAdvisory() });
    const prod = report({
      "1": rawAdvisory(),
      "9": rawAdvisory({ id: 9, github_advisory_id: "GHSA-ghost" }),
    });

    expect(audit(runnerFor(full, prod)).advisories).toHaveLength(1);
  });

  it("reads the advisory out of a non-zero exit, because findings are one", () => {
    // `pnpm audit` exits 1 whenever it found something, which here is the
    // normal case — so the exit code carries nothing this code can use.
    const runner: Runner = () => {
      const error = new Error("Command failed: pnpm audit --json") as Error & {
        stdout: string;
      };
      error.stdout = report({ "1": rawAdvisory() });
      throw error;
    };

    expect(audit(runner).advisories).toHaveLength(1);
  });

  it("rethrows a failure that carried no output at all", () => {
    const runner: Runner = () => {
      throw new Error("pnpm: command not found");
    };

    expect(() => audit(runner)).toThrow("command not found");
  });

  it("refuses empty output rather than reading it as a clean tree", () => {
    expect(() => audit(runnerFor("   ", "   "))).toThrow(/did not run/);
  });

  it("refuses output that is not JSON", () => {
    expect(() => audit(runnerFor("ERR_PNPM_AUDIT_BAD_RESPONSE", ""))).toThrow(
      /did not produce JSON/,
    );
  });

  it("refuses a payload with no `advisories` object", () => {
    // The shape changing under us would otherwise read as "nothing found",
    // which is the one wrong answer this job can give.
    expect(() =>
      audit(runnerFor(JSON.stringify({ metadata: {} }), report({}))),
    ).toThrow(/no `advisories` object/);
  });

  it("refuses a severity outside the known set", () => {
    const full = report({ "1": rawAdvisory({ severity: "spicy" }) });
    expect(() => audit(runnerFor(full, report({})))).toThrow(/severity/);
  });

  it("refuses an advisory that names no module", () => {
    const full = report({ "1": rawAdvisory({ module_name: null }) });
    expect(() => audit(runnerFor(full, report({})))).toThrow(/names no module/);
  });

  it("falls back to the registry's own id when there is no GHSA", () => {
    const full = report({
      "1117015": rawAdvisory({ github_advisory_id: "", id: 1117015 }),
    });

    expect(audit(runnerFor(full, report({}))).advisories[0]?.id).toBe(
      "1117015",
    );
  });

  it("deduplicates and sorts the installed versions and paths", () => {
    const full = report({
      "1": rawAdvisory({
        findings: [
          { version: "8.4.31", paths: [".>b>postcss", ".>a>postcss"] },
          { version: "8.4.31", paths: [".>a>postcss"] },
          { version: "8.2.0", paths: [".>c>postcss"] },
        ],
      }),
    });

    const [only] = audit(runnerFor(full, report({}))).advisories;
    expect(only?.installed).toEqual(["8.2.0", "8.4.31"]);
    expect(only?.paths).toEqual([".>a>postcss", ".>b>postcss", ".>c>postcss"]);
  });

  it("surfaces muted advisories instead of dropping them", () => {
    const full = report({}, { muted: ["GHSA-muted-muted-muted"] });
    expect(audit(runnerFor(full, report({}))).muted).toEqual([
      "GHSA-muted-muted-muted",
    ]);
  });
});

describe("ordering and counting", () => {
  it("sorts critical first and ties by module then identifier", () => {
    const sorted = [
      advisory({ id: "GHSA-b", severity: "low", module: "a" }),
      advisory({ id: "GHSA-a", severity: "critical", module: "z" }),
      advisory({ id: "GHSA-c", severity: "low", module: "a" }),
      advisory({ id: "GHSA-d", severity: "high", module: "m" }),
    ].sort(compareAdvisories);

    expect(sorted.map((a) => a.id)).toEqual([
      "GHSA-a",
      "GHSA-d",
      "GHSA-b",
      "GHSA-c",
    ]);
  });

  it("counts by severity and titles the issue with what is non-zero", () => {
    const advisories = [
      advisory({ id: "GHSA-1", severity: "critical" }),
      advisory({ id: "GHSA-2", severity: "low" }),
      advisory({ id: "GHSA-3", severity: "low" }),
    ];

    expect(countBySeverity(advisories)).toEqual({
      critical: 1,
      high: 0,
      moderate: 0,
      low: 2,
      info: 0,
    });
    expect(issueTitle(advisories)).toBe(
      `${ISSUE_TITLE_PREFIX}: 1 critical, 2 low`,
    );
  });
});

describe("fingerprint", () => {
  it("does not depend on the order the advisories arrive in", () => {
    const a = advisory({ id: "GHSA-1" });
    const b = advisory({ id: "GHSA-2", severity: "low" });

    expect(fingerprint([a, b])).toBe(fingerprint([b, a]));
  });

  it("ignores the title and the resolution paths", () => {
    // Both change when the registry rewords an advisory or a package moves in
    // the tree, and neither changes what a reader has to do about it. A body
    // rewritten for either would bury the week the set really moved.
    const before = advisory();
    const after = advisory({
      title: "left-pad pads left (updated wording)",
      paths: [".>something-else>left-pad"],
      url: "https://example.invalid/moved",
    });

    expect(fingerprint([after])).toBe(fingerprint([before]));
  });

  it("changes when an advisory crosses into the production graph", () => {
    const development = advisory({ production: false });
    expect(fingerprint([advisory()])).not.toBe(fingerprint([development]));
  });

  it("changes when the installed version moves under the same advisory", () => {
    expect(fingerprint([advisory({ installed: ["1.0.1"] })])).not.toBe(
      fingerprint([advisory()]),
    );
  });

  it("round-trips through the marker in a rendered body", () => {
    const advisories = [advisory(), advisory({ id: "GHSA-2" })];
    const body = renderIssueBody(result(advisories));

    expect(readFingerprint(body)).toBe(fingerprint(advisories));
  });

  it("reads back as undefined from a body nobody wrote a marker into", () => {
    expect(readFingerprint("somebody's hand-written issue")).toBeUndefined();
  });
});

describe("renderIssueBody", () => {
  const body = renderIssueBody(
    result(
      [
        advisory({ id: "GHSA-prod", module: "next", severity: "critical" }),
        advisory({
          id: "GHSA-dev",
          module: "@faker-js/faker",
          severity: "high",
          production: false,
        }),
      ],
      { muted: ["GHSA-muted"] },
    ),
    new Date("2026-09-30T00:00:00Z"),
  );

  it("separates the production graph from the development-only findings", () => {
    const production = body.indexOf("## In the production graph");
    const development = body.indexOf("## Development-only");

    expect(production).toBeGreaterThan(-1);
    expect(development).toBeGreaterThan(production);
    expect(body.slice(production, development)).toContain("`next`");
    expect(body.slice(production, development)).not.toContain("faker");
    expect(body.slice(development)).toContain("faker");
  });

  it("prints the muted advisories, which are invisible everywhere else", () => {
    expect(body).toContain("## Muted");
    expect(body).toContain("GHSA-muted");
  });

  it("omits a section that has nothing in it", () => {
    const onlyProduction = renderIssueBody(result([advisory()]));

    expect(onlyProduction).toContain("## In the production graph");
    expect(onlyProduction).not.toContain("## Development-only");
    expect(onlyProduction).not.toContain("## Muted");
  });

  it("says when it was written without letting that change the fingerprint", () => {
    const later = renderIssueBody(
      result([advisory()]),
      new Date("2027-01-04T00:00:00Z"),
    );
    const earlier = renderIssueBody(
      result([advisory()]),
      new Date("2026-09-30T00:00:00Z"),
    );

    expect(later).toContain("2027-01-04");
    expect(later).not.toBe(earlier);
    expect(readFingerprint(later)).toBe(readFingerprint(earlier));
  });

  it("names the workflow that wrote it, so the issue explains itself", () => {
    expect(body).toContain(".github/workflows/dependency-audit.yml");
    expect(body).toContain("docs/dependency-advisories.md");
  });
});

describe("identifiersIn", () => {
  it("reads the advisories back out of a body it rendered", () => {
    const advisories = [
      advisory({ id: "GHSA-aaa1-aaa1-aaa1" }),
      advisory({ id: "GHSA-bbb2-bbb2-bbb2", production: false }),
    ];

    expect(identifiersIn(renderIssueBody(result(advisories))).sort()).toEqual([
      "GHSA-aaa1-aaa1-aaa1",
      "GHSA-bbb2-bbb2-bbb2",
    ]);
  });

  it("finds nothing in a body with no advisory links", () => {
    expect(identifiersIn("no links here")).toEqual([]);
  });
});

describe("plan", () => {
  it("opens an issue when there is none and the tree is not clean", () => {
    const chosen = plan(result([advisory()]), []);

    expect(chosen.action).toBe("create");
    expect((chosen as Extract<Plan, { action: "create" }>).title).toContain(
      ISSUE_TITLE_PREFIX,
    );
  });

  it("does nothing at all when the tree is clean and no issue is open", () => {
    expect(plan(result([]), []).action).toBe("noop");
  });

  it("does nothing when the open issue already carries this fingerprint", () => {
    // The weekly no-op is the common case, and an edit or a comment on it
    // would bury the week the set actually moved.
    const advisories = [advisory()];
    const chosen = plan(result(advisories), [
      {
        number: 7,
        title: "whatever",
        body: renderIssueBody(result(advisories)),
      },
    ]);

    expect(chosen).toEqual({
      action: "noop",
      reason: expect.stringContaining("#7"),
    });
  });

  it("rewrites the body and comments the delta when the set changes", () => {
    const before = [advisory({ id: "GHSA-old-old-old" })];
    const after = [
      advisory({ id: "GHSA-old-old-old" }),
      advisory({ id: "GHSA-new-new-new", severity: "critical" }),
    ];

    const chosen = plan(result(after), [
      { number: 7, title: "old", body: renderIssueBody(result(before)) },
    ]) as Extract<Plan, { action: "update" }>;

    expect(chosen.action).toBe("update");
    expect(chosen.number).toBe(7);
    expect(chosen.comment).toContain("**New:**");
    expect(chosen.comment).toContain("GHSA-new-new-new");
    expect(chosen.comment).not.toContain("No longer reported");
  });

  it("names the advisories that went away", () => {
    const before = [
      advisory({ id: "GHSA-stays" }),
      advisory({ id: "GHSA-goes" }),
    ];

    const chosen = plan(result([advisory({ id: "GHSA-stays" })]), [
      { number: 7, title: "old", body: renderIssueBody(result(before)) },
    ]) as Extract<Plan, { action: "update" }>;

    expect(chosen.comment).toContain("**No longer reported:**");
    expect(chosen.comment).toContain("GHSA-goes");
    expect(chosen.comment).not.toContain("**New:**");
  });

  it("explains a change that added and dropped nothing", () => {
    // A version bump under an unchanged advisory, or a package crossing into
    // the production graph: the fingerprint moved and the identifier list did
    // not, and a comment saying only "the set changed" would read as a bug.
    const before = [advisory({ installed: ["1.0.0"] })];
    const after = [advisory({ installed: ["1.0.1"] })];

    const chosen = plan(result(after), [
      { number: 7, title: "old", body: renderIssueBody(result(before)) },
    ]) as Extract<Plan, { action: "update" }>;

    expect(chosen.comment).toContain("production/development classification");
  });

  it("treats an issue with no marker as out of date rather than current", () => {
    const chosen = plan(result([advisory()]), [
      { number: 7, title: "hand written", body: "somebody typed this" },
    ]);

    expect(chosen.action).toBe("update");
  });

  it("closes the open issue once the tree is clean", () => {
    const chosen = plan(result([]), [
      { number: 7, title: "old", body: renderIssueBody(result([advisory()])) },
    ]) as Extract<Plan, { action: "close" }>;

    expect(chosen.action).toBe("close");
    expect(chosen.number).toBe(7);
    expect(chosen.comment).toContain("new issue rather than reopening");
  });
});

describe("apply", () => {
  it("creates with the label that identifies the issue", () => {
    const { client, calls } = fakeClient();
    const line = apply(plan(result([advisory()]), []), client);

    expect(calls).toEqual([
      expect.stringContaining(`create(${ISSUE_TITLE_PREFIX}`),
    ]);
    expect(calls[0]).toContain(ADVISORY_LABEL);
    expect(line).toContain("Opened #42");
  });

  it("writes the body before the comment announcing it", () => {
    // A notification that arrives ahead of the state it describes sends its
    // reader to a stale table.
    const { client, calls } = fakeClient();
    const chosen = plan(result([advisory()]), [
      { number: 7, title: "old", body: "no marker" },
    ]);

    apply(chosen, client);
    expect(calls).toEqual([
      "update(#7, " + issueTitle([advisory()]) + ")",
      "comment(#7)",
    ]);
  });

  it("comments before closing, so the reason survives on the thread", () => {
    const { client, calls } = fakeClient();
    const chosen = plan(result([]), [
      { number: 7, title: "old", body: renderIssueBody(result([advisory()])) },
    ]);

    expect(apply(chosen, client)).toContain("Closed #7");
    expect(calls).toEqual(["comment(#7)", "close(#7)"]);
  });

  it("touches nothing on a no-op", () => {
    const { client, calls } = fakeClient();

    expect(apply({ action: "noop", reason: "nothing moved" }, client)).toBe(
      "Nothing to do — nothing moved.",
    );
    expect(calls).toEqual([]);
  });
});

describe("ghClient", () => {
  /** Records the argv `gh` would have been called with. */
  function recordingGh(responses: string[] = []) {
    const calls: string[][] = [];
    let index = 0;

    const run: Runner = (command, args) => {
      expect(command).toBe("gh");
      calls.push([...args]);
      return responses[index++] ?? "";
    };

    return { run, calls };
  }

  it("scopes every call to the repository it was given", () => {
    const { run, calls } = recordingGh(["[]"]);

    ghClient("owner/repo", run).listOpen(ADVISORY_LABEL);

    expect(calls[0]?.slice(-2)).toEqual(["--repo", "owner/repo"]);
    expect(calls[0]).toContain(ADVISORY_LABEL);
    expect(calls[0]).toContain("--state");
    expect(calls[0]).toContain("open");
  });

  it("omits `--repo` when there is none, so `gh` uses the checkout", () => {
    const { run, calls } = recordingGh(["[]"]);

    ghClient(undefined, run).listOpen(ADVISORY_LABEL);

    expect(calls[0]).not.toContain("--repo");
  });

  it("reads an empty listing as no open issues", () => {
    // `gh` prints nothing at all rather than `[]` in some versions, and
    // `JSON.parse("")` throws — which would fail the run on the healthiest
    // possible state.
    const { run } = recordingGh([""]);

    expect(ghClient("o/r", run).listOpen(ADVISORY_LABEL)).toEqual([]);
  });

  it("refuses a listing that is not an array", () => {
    const { run } = recordingGh(['{"message":"Not Found"}']);

    expect(() => ghClient("o/r", run).listOpen(ADVISORY_LABEL)).toThrow(
      /did not return an array/,
    );
  });

  it("refuses a row with no issue number rather than defaulting one", () => {
    const { run } = recordingGh(['[{"title":"x","body":"y"}]']);

    expect(() => ghClient("o/r", run).listOpen(ADVISORY_LABEL)).toThrow(
      /unnumbered row/,
    );
  });

  it("reads the new issue's number out of the URL `gh` prints", () => {
    const { run, calls } = recordingGh([
      "https://github.com/owner/repo/issues/123\n",
    ]);

    const number = ghClient("owner/repo", run).create({
      title: "Dependency advisories: 1 critical",
      body: "# body",
      label: ADVISORY_LABEL,
    });

    expect(number).toBe(123);
    // The body goes through a file, never an argument: an advisory title is
    // remote text, and a thirty-advisory body is past `ARG_MAX` besides.
    expect(calls[0]).toContain("--body-file");
    expect(calls[0]?.join(" ")).not.toContain("# body");
  });

  it("refuses output it cannot read an issue number out of", () => {
    const { run } = recordingGh(["Welcome to GitHub CLI!"]);

    expect(() =>
      ghClient("o/r", run).create({ title: "t", body: "b", label: "l" }),
    ).toThrow(/could not read an issue number/);
  });

  it("writes the body to a file the command can actually read", () => {
    let seen = "";
    const run: Runner = (_command, args) => {
      const file = args[args.indexOf("--body-file") + 1] as string;
      seen = readFileSync(file, "utf8");
      return "";
    };

    ghClient("o/r", run).comment({ number: 7, body: "the delta" });
    expect(seen).toBe("the delta");
  });

  it("closes as completed rather than as not-planned", () => {
    const { run, calls } = recordingGh([""]);

    ghClient("o/r", run).close({ number: 7 });
    expect(calls[0]).toEqual([
      "issue",
      "close",
      "7",
      "--reason",
      "completed",
      "--repo",
      "o/r",
    ]);
  });
});
