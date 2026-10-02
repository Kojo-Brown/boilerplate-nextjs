import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CATEGORIES,
  CHECKLIST_FILE,
  DEPENDABOT_FILE,
  FETCH_CALL_SITES,
  NEXT_CONFIG_FILE,
  PACKAGE_FILE,
  check,
  declaresTest,
  fetchCallSites,
  isCollectedByVitest,
  parseChecklist,
  RAW_SQL_CALL_SITES,
  rawSqlUses,
  remotePatterns,
  supplyChain,
} from "./assert-owasp-checklist";

const REPO = process.cwd();

/**
 * The parts of the repository this gate reads, copied so a case can break one.
 *
 * Copying rather than hand-writing fixtures, for the reason
 * `assert-server-only.test.ts` gives: every case below is then a statement about
 * *this* tree — the gate passes on it as it stands and fails on it with one thing
 * changed. A fixture would only prove that a regex matches a string somebody
 * wrote to be matched.
 */
const COPIED = [
  "src",
  "scripts",
  "eslint-rules",
  "prisma",
  "docs",
  ".github",
  // Cited by A08 and scanned by T4, and its absence here was quietly
  // producing a C3 finding in every temp tree — a false one, which is the
  // kind that hides a real one: the two C5 cases below were passing on a
  // `toContain` while the list they inspected held a rule neither of them
  // was about.
  "workflow-templates",
  "next.config.ts",
  "package.json",
  "SPEC.md",
];

function withTree(
  mutate: (root: string) => void = () => {},
  paths: readonly string[] = COPIED,
): string {
  const root = mkdtempSync(path.join(tmpdir(), "owasp-gate-"));

  for (const entry of paths) {
    cpSync(path.join(REPO, entry), path.join(root, entry), { recursive: true });
  }
  mutate(root);
  return root;
}

function edit(
  root: string,
  file: string,
  fn: (source: string) => string,
): void {
  const target = path.join(root, file);
  writeFileSync(target, fn(readFileSync(target, "utf8")), "utf8");
}

function write(root: string, file: string, text: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, "utf8");
}

/** The findings this gate produced, by rule. */
function rules(findings: { rule: string }[]): string[] {
  return [...new Set(findings.map((finding) => finding.rule))].sort();
}

describe("the gate passes on this repository", () => {
  it("finds nothing", () => {
    expect(check(REPO)).toEqual([]);
  });
});

describe("the checklist parser", () => {
  it("reads every category, its mitigations and their tests", () => {
    const categories = parseChecklist(
      readFileSync(path.join(REPO, CHECKLIST_FILE), "utf8"),
    );

    // Asserted because every C rule is a claim about this parser's output: a
    // parser that quietly found nothing would make all of them pass.
    expect(categories.map((category) => category.name)).toEqual([
      ...CATEGORIES,
    ]);
    for (const category of categories) {
      expect(category.mitigations.length, category.name).toBeGreaterThan(0);
      for (const mitigation of category.mitigations) {
        expect(mitigation.tests.length, mitigation.summary).toBeGreaterThan(0);
      }
    }
  });

  it("does not read a following section's bullets as the last category's", () => {
    const categories = parseChecklist(
      [
        `### ${CATEGORIES[0]}`,
        "- **Mitigation** — one. `src/proxy.ts`",
        '  - **Test** `src/proxy.test.ts` › "covers NextAuth\'s endpoints"',
        "",
        "## Running the gate",
        "- **Mitigation** — stray. `src/proxy.ts`",
      ].join("\n"),
    );

    expect(categories).toHaveLength(1);
    expect(categories[0]!.mitigations).toHaveLength(1);
  });

  it("reads a Gap bullet's SPEC reference, and notices one without", () => {
    const categories = parseChecklist(
      [
        `### ${CATEGORIES[0]}`,
        "- **Gap** — tracked. SPEC: Some open item",
        "- **Gap** — untracked, which is the failure.",
      ].join("\n"),
    );

    expect(categories[0]!.gaps).toEqual(["Some open item"]);
    expect(categories[0]!.malformedGaps).toHaveLength(1);
  });
});

describe("declaresTest", () => {
  it("finds a title declared by it, test or describe", () => {
    expect(declaresTest('it("a title", () => {});', "a title")).toBe(true);
    expect(declaresTest('test("a title", () => {});', "a title")).toBe(true);
    expect(declaresTest('describe("a title", () => {});', "a title")).toBe(
      true,
    );
  });

  it("finds an it.each title, whose template carries placeholders", () => {
    const source = `it.each([
      ["one", 1],
    ])("handles %s", () => {});`;

    expect(declaresTest(source, "handles %s")).toBe(true);
  });

  it("does not count a title that only appears in a comment", () => {
    // The drift this rule exists for: a test is deleted and its name survives
    // in the comment above whatever replaced it.
    expect(declaresTest('// it("a title", …) used to be here', "a title")).toBe(
      false,
    );
  });

  it("is not fooled by a substring of a longer title", () => {
    expect(declaresTest('it("a title and more", () => {});', "a title")).toBe(
      false,
    );
  });
});

describe("isCollectedByVitest", () => {
  it("accepts the three directories the projects include", () => {
    expect(isCollectedByVitest("src/proxy.test.ts")).toBe(true);
    expect(isCollectedByVitest("scripts/assert-csp.test.ts")).toBe(true);
    expect(isCollectedByVitest("eslint-rules/server-only.test.ts")).toBe(true);
  });

  it("rejects a Playwright spec and a non-test file", () => {
    // `e2e/` is excluded from both Vitest projects, so a citation there is a
    // citation to something `pnpm test` never runs.
    expect(isCollectedByVitest("e2e/login.spec.ts")).toBe(false);
    expect(isCollectedByVitest("src/proxy.ts")).toBe(false);
  });
});

describe("C1 — all ten categories, in order", () => {
  it("fails when a category is missing", () => {
    const root = withTree((tree) => {
      edit(tree, CHECKLIST_FILE, (source) =>
        source.replace(`### ${CATEGORIES[7]}`, "### Something else"),
      );
    });

    expect(rules(check(root))).toContain("C1");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails when the checklist does not exist at all", () => {
    const root = withTree((tree) => {
      rmSync(path.join(tree, CHECKLIST_FILE));
    });

    const findings = check(root);
    expect(findings.some((finding) => finding.rule === "C1")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("C2 — every mitigation is evidenced", () => {
  it("fails a mitigation that cites no test", () => {
    const root = withTree((tree) => {
      edit(tree, CHECKLIST_FILE, (source) =>
        source.replace(
          `### ${CATEGORIES[1]}`,
          `- **Mitigation** — trust me. \`src/proxy.ts\`\n\n### ${CATEGORIES[1]}`,
        ),
      );
    });

    expect(rules(check(root))).toContain("C2");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("C3 — cited modules exist", () => {
  it("fails a mitigation naming a module that was renamed away", () => {
    const root = withTree((tree) => {
      edit(tree, CHECKLIST_FILE, (source) =>
        source.replace(
          "`src/lib/security/safe-redirect.ts`",
          "`src/lib/security/safe-redirects.ts`",
        ),
      );
    });

    expect(rules(check(root))).toContain("C3");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("C4 — cited tests exist and run", () => {
  it("fails a citation to a test title nothing declares", () => {
    const root = withTree((tree) => {
      edit(tree, CHECKLIST_FILE, (source) =>
        source.replace(
          '"rejects control characters, which split a Location header"',
          '"rejects control characters"',
        ),
      );
    });

    expect(rules(check(root))).toContain("C4");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails a citation to a test file Vitest does not collect", () => {
    const root = withTree((tree) => {
      write(tree, "e2e/security.spec.ts", 'it("a browser check", () => {});');
      edit(tree, CHECKLIST_FILE, (source) =>
        source.replace(
          '  - **Test** `src/lib/prose.test.ts` › "keeps text that looks like markup as text"',
          '  - **Test** `e2e/security.spec.ts` › "a browser check"',
        ),
      );
    });

    expect(rules(check(root))).toContain("C4");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("C5 — a gap tracks an open spec item", () => {
  // These two cases outlived five gaps, sabotaging each in turn — the
  // file-upload deferral, the log-redaction one, A08's tag pinning, A06's
  // advisory audit, and finally A01's cross-tenant draft preview. Every time,
  // the rule did exactly what it exists for: ticking the item failed this gate
  // until the document was revisited. With A01's closed there are no `**Gap**`
  // bullets left anywhere in the checklist.
  //
  // The note that used to live here said that at this point the honest move was
  // to delete these cases along with rule C5, rather than invent a gap for them
  // to live in. The first half of that does not follow from the second. C5
  // protects the *next* deferral, which is a thing a security checklist will
  // certainly acquire again, and deleting a rule because nothing currently
  // violates it is how a gate stops covering the case it was written for. What
  // was right about it is that the real document must not carry a fake gap.
  //
  // So the gap is injected into the *copy* — which is what every other case in
  // this file already does with the condition it is testing — and nothing is
  // left in `docs/owasp-top-10.md` claiming a deferral that is not one.
  //
  // Both halves are injected: the bullet into the checklist and the `- [ ]` line
  // into `SPEC.md`. Naming a real open item instead would work today and would
  // couple these cases to whichever item that is, so the run that ticks it would
  // break them — which is precisely how these tests came to be attached to a
  // string of unrelated gaps in the first place.
  const GAP_ITEM = "A synthetic spec item that only this test knows about";

  /** Adds a `**Gap**` bullet to A01, and the open spec line it refers to. */
  function withGap(
    tree: string,
    bullet = `- **Gap** — a synthetic deferral, injected by this test. SPEC: ${GAP_ITEM}`,
  ): void {
    edit(tree, CHECKLIST_FILE, (source) =>
      source.replace(
        "\n### A02:2021 — Cryptographic Failures",
        `\n${bullet}\n\n### A02:2021 — Cryptographic Failures`,
      ),
    );
    edit(tree, "SPEC.md", (source) => `${source}\n- [ ] ${GAP_ITEM}\n`);
  }

  it("passes a Gap bullet whose spec item is still open", () => {
    // The control, and it has to come first: without it the three failures below
    // could all be the injection being malformed rather than the rule firing.
    const root = withTree(withGap);

    expect(rules(check(root))).not.toContain("C5");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails when the item it defers to has been ticked", () => {
    // The point of the rule: finishing the deferred work is what makes this
    // document wrong, so finishing it has to fail the gate.
    const root = withTree((tree) => {
      withGap(tree);
      edit(tree, "SPEC.md", (source) =>
        source.replace(`- [ ] ${GAP_ITEM}`, `- [x] ${GAP_ITEM}`),
      );
    });

    expect(rules(check(root))).toContain("C5");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails a Gap bullet with no SPEC reference", () => {
    const root = withTree((tree) => {
      withGap(tree, "- **Gap** — one day, probably.");
    });

    expect(rules(check(root))).toContain("C5");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails a Gap bullet naming an item that is not in SPEC.md at all", () => {
    // The other way the reference rots, and the one a rename produces: the
    // bullet still says `SPEC:` and the wording no longer matches a line.
    const root = withTree((tree) => {
      withGap(
        tree,
        "- **Gap** — a synthetic deferral. SPEC: Something nobody ever wrote down",
      );
    });

    expect(rules(check(root))).toContain("C5");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("C6 — one test, one row", () => {
  it("fails when two categories rest on the same assertion", () => {
    const root = withTree((tree) => {
      edit(tree, CHECKLIST_FILE, (source) =>
        source.replace(
          '  - **Test** `src/lib/prose.test.ts` › "keeps text that looks like markup as text"',
          '  - **Test** `src/lib/password.test.ts` › "produces different hashes for the same password"',
        ),
      );
    });

    expect(rules(check(root))).toContain("C6");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("T1 — no raw SQL", () => {
  it("finds a raw query anywhere in the source", () => {
    const root = withTree((tree) => {
      write(
        tree,
        "src/lib/dal/report.ts",
        "export const rows = (q: string) => prisma.$queryRawUnsafe(q);\n",
      );
    });

    const findings = rawSqlUses(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe("src/lib/dal/report.ts");
    rmSync(root, { recursive: true, force: true });
  });

  it("does not fire on a module listed in RAW_SQL_CALL_SITES", () => {
    // The rule became an allowlist when row-level security arrived: opening a
    // tenant scope is `SELECT set_config(…)`, and Prisma's builder models rows
    // rather than session state, so there is no non-raw spelling of it.
    const root = withTree();

    expect(
      rawSqlUses(root).filter((finding) =>
        RAW_SQL_CALL_SITES.some((entry) => entry.file === finding.file),
      ),
    ).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("fires on a stale allowlist entry", () => {
    // An entry naming a file that no longer issues a raw query is a hole
    // waiting for a file of that name — the same failure `FETCH_CALL_SITES`
    // guards against, and the reason both lists are checked in both directions.
    const root = withTree((tree) => {
      for (const entry of RAW_SQL_CALL_SITES) {
        write(tree, entry.file, "export const nothing = 1;\n");
      }
    });

    const findings = rawSqlUses(root);

    expect(findings).toHaveLength(RAW_SQL_CALL_SITES.length);
    expect(findings.every((finding) => finding.message.includes("stale"))).toBe(
      true,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("still fires on an unlisted module that uses the unsafe form", () => {
    // Every allowlisted entry uses a tagged template, so every interpolation
    // is a bind parameter. `$queryRawUnsafe` is the string-concatenation form
    // and is in no entry's reason.
    const root = withTree((tree) => {
      write(
        tree,
        "src/lib/tenancy/oops.ts",
        "export const rows = (t: string) => prisma.$queryRawUnsafe(`SET x = ${t}`);\n",
      );
    });

    expect(
      rawSqlUses(root).some((f) => f.file === "src/lib/tenancy/oops.ts"),
    ).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not fire on the method name inside a comment", () => {
    const root = withTree((tree) => {
      write(
        tree,
        "src/lib/dal/note.ts",
        "// Deliberately not $queryRawUnsafe — see docs/owasp-top-10.md.\nexport const x = 1;\n",
      );
    });

    expect(rawSqlUses(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("T2 — the outbound call sites are enumerated", () => {
  it("fails a fetch call site that is not on the list", () => {
    const root = withTree((tree) => {
      write(
        tree,
        "src/lib/thumbnail.ts",
        "export const grab = (url: string) => fetch(url);\n",
      );
    });

    const findings = fetchCallSites(root);
    expect(findings.map((finding) => finding.file)).toContain(
      "src/lib/thumbnail.ts",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("fails a list entry that no longer fetches", () => {
    // A stale entry is a hole waiting for a file of that name.
    const root = withTree((tree) => {
      edit(tree, FETCH_CALL_SITES[0]!.file, (source) =>
        source.replace(/fetch/g, "send"),
      );
    });

    expect(fetchCallSites(root).map((finding) => finding.rule)).toContain("T2");
    rmSync(root, { recursive: true, force: true });
  });

  it("counts a member call named fetch, which cannot be told from the real one", () => {
    // `o.fetch()` and `environment.fetch()` are the same text, and one of them
    // is an outbound request. So the rule counts both and `@/lib/dal/batch.ts`
    // earns a list entry whose reason says it is a DataLoader callback — which
    // is a sentence a reviewer can check, unlike a heuristic nobody can see.
    const root = withTree((tree) => {
      write(
        tree,
        "src/lib/loader.ts",
        "export const run = (o: { fetch: () => void }) => o.fetch();\n",
      );
    });

    expect(fetchCallSites(root).map((finding) => finding.file)).toContain(
      "src/lib/loader.ts",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("does not count a property key named fetch, or the word in prose", () => {
    // `@/lib/dal/loaders.ts` supplies `fetch:` to the batch loader, and
    // `@/lib/api/runtimes.ts` has a route description containing the word.
    // Either one read as a call site is a rule that fires on documentation.
    const root = withTree((tree) => {
      write(
        tree,
        "src/lib/note.ts",
        'export const o = { fetch: () => 1 };\nexport const why = "one outbound fetch";\n',
      );
    });

    expect(fetchCallSites(root).map((finding) => finding.file)).not.toContain(
      "src/lib/note.ts",
    );
    rmSync(root, { recursive: true, force: true });
  });
});

describe("T3 — the image allowlist is anchored", () => {
  it("fails an unanchored image hostname", () => {
    const root = withTree((tree) => {
      edit(tree, NEXT_CONFIG_FILE, (source) =>
        source.replace('hostname: "images.unsplash.com"', 'hostname: "**"'),
      );
    });

    const findings = remotePatterns(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("every host");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails a remote pattern that allows plain http", () => {
    const root = withTree((tree) => {
      edit(tree, NEXT_CONFIG_FILE, (source) =>
        source.replace(
          'protocol: "https",\n        hostname: "images',
          'protocol: "http",\n        hostname: "images',
        ),
      );
    });

    expect(
      remotePatterns(root)
        .map((finding) => finding.message)
        .join(" "),
    ).toContain("http");
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts a domain-anchored wildcard, which is what this repo uses", () => {
    expect(remotePatterns(REPO)).toEqual([]);
  });
});

describe("T4 — the supply chain", () => {
  it("fails a CI install that is not frozen to the lockfile", () => {
    const root = withTree((tree) => {
      edit(tree, ".github/workflows/ci.yml", (source) =>
        source.replace(
          "pnpm install --frozen-lockfile --strict-peer-dependencies",
          "pnpm install",
        ),
      );
    });

    const findings = supplyChain(root);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.message).toContain("--frozen-lockfile");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails when dependabot stops covering an ecosystem", () => {
    const root = withTree((tree) => {
      edit(tree, DEPENDABOT_FILE, (source) =>
        source.replace(
          "package-ecosystem: github-actions",
          "package-ecosystem: bundler",
        ),
      );
    });

    expect(
      supplyChain(root)
        .map((finding) => finding.message)
        .join(" "),
    ).toContain("github-actions");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails when the dependabot config is deleted", () => {
    const root = withTree((tree) => {
      rmSync(path.join(tree, DEPENDABOT_FILE));
    });

    expect(supplyChain(root).map((finding) => finding.file)).toContain(
      DEPENDABOT_FILE,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("fails an action pinned to a moving branch", () => {
    const root = withTree((tree) => {
      // Every `uses:` is a digest now, so the sabotage is a digest put back on
      // a branch rather than a tag swapped for one. This rule only ever saw
      // `@main`; `scripts/assert-action-pins.ts` is what fails the tag.
      edit(tree, ".github/workflows/ci.yml", (source) =>
        source.replace(
          /uses: actions\/checkout@[0-9a-f]{40}.*$/m,
          "uses: actions/checkout@main",
        ),
      );
    });

    expect(
      supplyChain(root)
        .map((finding) => finding.message)
        .join(" "),
    ).toContain("moving branch");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails an unpinned package manager", () => {
    const root = withTree((tree) => {
      edit(tree, PACKAGE_FILE, (source) =>
        source.replace(
          /"packageManager": "pnpm@[^"]+"/,
          '"packageManager": "pnpm"',
        ),
      );
    });

    expect(supplyChain(root).map((finding) => finding.file)).toContain(
      PACKAGE_FILE,
    );
    rmSync(root, { recursive: true, force: true });
  });
});
