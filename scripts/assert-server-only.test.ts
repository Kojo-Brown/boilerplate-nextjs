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
  CLIENT_ENV_MODULE,
  chainTo,
  check,
  rawSecretReads,
  serverEnvImporters,
} from "./assert-server-only";
import { ENV_MODULE, parseSecretKeys } from "../eslint-rules/server-only.mjs";

const REPO = process.cwd();

/**
 * A copy of the real `src/`, which the caller then breaks in one specific way.
 *
 * Copying the tree rather than writing fixtures is what makes each case below a
 * statement about *this* repository: the gate has to pass on the tree as it
 * stands and fail on the tree with one line changed. A hand-written fixture
 * would only prove the regex works.
 */
function withBrokenTree(
  edits: { file: string; edit: (source: string) => string }[],
  added: { file: string; text: string }[] = [],
): string {
  const root = mkdtempSync(path.join(tmpdir(), "server-only-gate-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });

  for (const { file, edit } of edits) {
    const target = path.join(root, file);
    writeFileSync(target, edit(readFileSync(target, "utf8")), "utf8");
  }
  for (const { file, text } of added) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }
  return root;
}

const unmark = (source: string) =>
  source.replace('import "server-only";\n\n', "");

describe("the gate passes on this repository", () => {
  it("finds nothing", () => {
    expect(check(REPO)).toEqual([]);
  });
});

describe("R1 — the marker and the list it protects", () => {
  it("fails when the env module loses the marker", () => {
    // One deleted line, and every guarantee below it goes with it: the unit
    // suite aliases `server-only` to an empty module, and a build with no client
    // component importing the module is green either way.
    const root = withBrokenTree([{ file: ENV_MODULE, edit: unmark }]);

    const findings = check(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "R1", file: ENV_MODULE });
  });

  it("fails when SECRET_KEYS stops being parseable", () => {
    const root = withBrokenTree([
      {
        file: ENV_MODULE,
        edit: (source) =>
          source.replace(
            "export const SECRET_KEYS = [",
            "export const SECRET_NAMES = [",
          ),
      },
    ]);

    const findings = check(root);
    expect(findings.some((finding) => finding.rule === "R1")).toBe(true);
    expect(findings[0]!.message).toContain("SECRET_KEYS");
  });

  it("fails on a secret name the schema does not declare", () => {
    // What a rename leaves behind. Both readers match on the name, so a stale
    // entry is a secret nothing enforces — and an entry for a variable that was
    // renamed in the schema means the *new* name is unguarded.
    const root = withBrokenTree([
      {
        file: ENV_MODULE,
        edit: (source) =>
          source.replace('"REVALIDATE_SECRET",', '"REVALIDATION_SECRET",'),
      },
    ]);

    const findings = check(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("REVALIDATION_SECRET");
  });
});

describe("R2 — no marked module in the client graph", () => {
  it("fails when a client component imports the env module, and names the chain", () => {
    const root = withBrokenTree(
      [],
      [
        {
          file: "src/components/probe.tsx",
          text:
            '"use client";\nimport { serverEnv } from "@/lib/env/server";\n' +
            "export const Probe = () => <span>{serverEnv.NODE_ENV}</span>;\n",
        },
      ],
    );

    const findings = check(root).filter((finding) => finding.rule === "R2");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain(
      "src/components/probe.tsx → src/lib/env/server.ts",
    );
  });

  it("reports the chain through an intermediate helper", () => {
    const root = withBrokenTree(
      [],
      [
        {
          file: "src/components/probe.tsx",
          text: '"use client";\nimport "@/lib/probe-helper";\nexport const Probe = () => null;\n',
        },
        {
          file: "src/lib/probe-helper.ts",
          text: 'import { serverEnv } from "@/lib/env/server";\nexport const url = serverEnv.DATABASE_URL;\n',
        },
      ],
    );

    const chains = check(root)
      .filter((finding) => finding.rule === "R2")
      .map((finding) => finding.message);
    expect(chains.join("\n")).toContain(
      "src/components/probe.tsx → src/lib/probe-helper.ts → src/lib/env/server.ts",
    );
  });

  it("does not fire on a type-only import", () => {
    // The false positive this gate was written against. `src/hooks/use-posts.ts`
    // is a `"use client"` module whose only link to the data layer is
    // `import type { PostSummary }`, which TypeScript erases entirely — so the
    // bundler never follows it and `next build` is correct to succeed. A gate
    // that disagreed with the bundler would have to be ignored to ship.
    const root = withBrokenTree(
      [],
      [
        {
          file: "src/components/probe.tsx",
          text:
            '"use client";\nimport type { serverEnv } from "@/lib/env/server";\n' +
            "export type Probe = typeof serverEnv;\n",
        },
      ],
    );

    expect(check(root).filter((finding) => finding.rule === "R2")).toEqual([]);
  });
});

describe("R3 — every reader of the server env is marked", () => {
  it("fails when a marked reader loses its marker", () => {
    const root = withBrokenTree([
      { file: "src/lib/webhooks/signature.ts", edit: unmark },
    ]);

    const findings = check(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "R3",
      file: "src/lib/webhooks/signature.ts",
    });
  });

  it("accepts a `use server` module unmarked", () => {
    // `src/actions/upload.ts` reads four S3 variables and carries no marker:
    // Next replaces a `"use server"` module with a reference on the client side,
    // so there is nothing for the marker to add.
    expect(
      serverEnvImporters([
        {
          relativePath: "src/actions/thing.ts",
          text: '"use server";\nimport { serverEnv } from "@/lib/env/server";',
        },
        { relativePath: ENV_MODULE, text: 'import "server-only";' },
      ]).map((file) => file.relativePath),
    ).toEqual(["src/actions/thing.ts"]);

    expect(
      check(
        withBrokenTree(
          [],
          [
            {
              file: "src/actions/probe.ts",
              text: '"use server";\nimport { serverEnv } from "@/lib/env/server";\nexport async function probe() {\n  return serverEnv.NODE_ENV;\n}\n',
            },
          ],
        ),
      ),
    ).toEqual([]);
  });

  it("ignores a type-only import of the env module", () => {
    expect(
      serverEnvImporters([
        {
          relativePath: "src/lib/thing.ts",
          text: 'import type { serverEnv } from "@/lib/env/server";',
        },
        { relativePath: ENV_MODULE, text: 'import "server-only";' },
      ]),
    ).toEqual([]);
  });
});

describe("R4 — no raw secret reads", () => {
  it("fails on the read src/auth.ts actually had", () => {
    // Before this item, `src/auth.ts` built its Google provider from
    // `process.env["GOOGLE_CLIENT_SECRET"] ?? ""` — an OAuth client configured
    // with an empty secret whenever the variable is absent, and a read no
    // marker can see because there is no import on that path.
    const root = withBrokenTree([
      {
        file: "src/auth.ts",
        edit: (source) =>
          source.replace(
            'clientSecret: serverEnv.GOOGLE_CLIENT_SECRET ?? "",',
            'clientSecret: process.env["GOOGLE_CLIENT_SECRET"] ?? "",',
          ),
      },
    ]);

    const findings = check(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "R4", file: "src/auth.ts" });
    expect(findings[0]!.message).toContain("GOOGLE_CLIENT_SECRET");
  });

  it("reads both member spellings and the destructured form", () => {
    expect(
      rawSecretReads(
        [
          {
            relativePath: "src/a.ts",
            text: "const a = process.env.NEXTAUTH_SECRET;",
          },
          {
            relativePath: "src/b.ts",
            text: 'const b = process.env["DATABASE_URL"];',
          },
          {
            relativePath: "src/c.ts",
            text: "const { PREVIEW_SECRET } = process.env;",
          },
        ],
        ["NEXTAUTH_SECRET", "DATABASE_URL", "PREVIEW_SECRET"],
      ),
    ).toEqual([
      { file: "src/a.ts", key: "NEXTAUTH_SECRET" },
      { file: "src/b.ts", key: "DATABASE_URL" },
      { file: "src/c.ts", key: "PREVIEW_SECRET" },
    ]);
  });

  it("leaves server configuration that is not a secret alone", () => {
    // `src/lib/security/apply.ts` reads NODE_ENV and a report-only flag, and
    // `src/lib/auth/deployment.ts` reads AUTH_URL. None of them is key material,
    // and a rule that covered them would be a rule about where configuration is
    // read rather than about what a browser can be handed.
    expect(
      rawSecretReads(
        [
          {
            relativePath: "src/a.ts",
            text: 'const a = process.env["NODE_ENV"] ?? process.env["AUTH_URL"];',
          },
        ],
        ["NEXTAUTH_SECRET", "DATABASE_URL"],
      ),
    ).toEqual([]);
  });

  it("does not read a secret name out of a comment", () => {
    expect(
      rawSecretReads(
        [
          {
            relativePath: "src/a.ts",
            text: "// never write process.env.NEXTAUTH_SECRET here\nexport const a = 1;",
          },
        ],
        ["NEXTAUTH_SECRET"],
      ),
    ).toEqual([]);
  });
});

describe("R5 — the public env module stays public", () => {
  it("fails when it imports the server module", () => {
    // Nothing else would: no client component imports `@/lib/env/client` today,
    // so the build only notices once one does — at which point the breakage
    // belongs to whoever wrote that component.
    const root = withBrokenTree([
      {
        file: CLIENT_ENV_MODULE,
        edit: (source) =>
          `import { serverEnv } from "@/lib/env/server";\n${source}\nexport const leak = serverEnv.NODE_ENV;\n`,
      },
    ]);

    const findings = check(root).filter((finding) => finding.rule === "R5");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("src/lib/env/server.ts");
  });

  it("fails when it is marked itself", () => {
    const root = withBrokenTree([
      {
        file: CLIENT_ENV_MODULE,
        edit: (source) => `import "server-only";\n\n${source}`,
      },
    ]);

    expect(
      check(root).some(
        (finding) =>
          finding.rule === "R5" && finding.message.includes("client component"),
      ),
    ).toBe(true);
  });
});

describe("chainTo", () => {
  it("walks the parent edges back to the entry point", () => {
    const reached = new Map<string, string | null>([
      ["src/a.tsx", null],
      ["src/b.ts", "src/a.tsx"],
      ["src/c.ts", "src/b.ts"],
    ]);

    expect(chainTo("src/c.ts", reached)).toEqual([
      "src/a.tsx",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  it("stops rather than looping on a cycle", () => {
    const reached = new Map<string, string | null>([
      ["src/a.ts", "src/b.ts"],
      ["src/b.ts", "src/a.ts"],
    ]);

    expect(chainTo("src/a.ts", reached)).toEqual(["src/b.ts", "src/a.ts"]);
  });
});

describe("parseSecretKeys", () => {
  it("reads the array the ESLint rule and the gate share", () => {
    expect(
      parseSecretKeys(
        'export const SECRET_KEYS = [\n  "A_KEY",\n  // a comment\n  "B_KEY",\n] as const;',
      ),
    ).toEqual(["A_KEY", "B_KEY"]);
  });

  it("returns null rather than an empty list when the declaration moves", () => {
    // An empty list is a rule that reports nothing and a gate that passes
    // everything, which is why neither caller accepts one.
    expect(parseSecretKeys("export const OTHER = [] as const;")).toBeNull();
    expect(
      parseSecretKeys("export const SECRET_KEYS = [] as const;"),
    ).toBeNull();
  });

  it("agrees with the repository's own list", () => {
    const keys = parseSecretKeys(
      readFileSync(path.join(REPO, ENV_MODULE), "utf8"),
    );
    expect(keys).toContain("NEXTAUTH_SECRET");
    expect(keys).toContain("DATABASE_URL");
  });
});
