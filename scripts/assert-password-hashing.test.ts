import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  check,
  parameterLiteral,
  withoutComments,
  AUTH_FILE,
  PASSWORD_FILE,
  POLICY_FLOOR,
} from "./assert-password-hashing";

const REPO = process.cwd();

/**
 * A copy of the real sources, broken in one specific way.
 *
 * Copying the tree rather than writing fixtures is what makes each case below
 * a statement about *this* repository: the gate has to pass as it stands and
 * fail with one line changed. A hand-written fixture would only prove that a
 * regex matches a string somebody wrote to make it match.
 */
function withBrokenTree(
  edits: { file: string; edit: (source: string) => string }[],
): string {
  const root = mkdtempSync(path.join(tmpdir(), "password-gate-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "prisma"), { recursive: true });
  cpSync(path.join(REPO, "prisma/seed.ts"), path.join(root, "prisma/seed.ts"));

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

async function rulesFiring(
  edits: { file: string; edit: (source: string) => string }[],
): Promise<string[]> {
  const findings = await check(withBrokenTree(edits));
  return [...new Set(findings.map((finding) => finding.rule))];
}

describe("assert-password-hashing", () => {
  it("passes against the repository as it stands", async () => {
    expect(await check(REPO)).toEqual([]);
  });

  it("R1 — fires when sign-in stops upgrading the hash", async () => {
    const rules = await rulesFiring([
      {
        file: AUTH_FILE,
        edit: (source) =>
          source.replace(/await upgradePasswordHash\(/, "void (("),
      },
    ]);
    expect(rules).toContain("R1");
  });

  it("R1 — fires when the upgrade is left floating rather than awaited", async () => {
    // The spelling that works locally and never runs in production, because a
    // serverless runtime tears the invocation down when the response is sent.
    const rules = await rulesFiring([
      {
        file: AUTH_FILE,
        edit: (source) =>
          source.replace(
            "await upgradePasswordHash(",
            "void upgradePasswordHash(",
          ),
      },
    ]);
    expect(rules).toContain("R1");
  });

  it("R2 — fires when a second module derives a key of its own", async () => {
    const rules = await rulesFiring([
      {
        file: "src/lib/auth/password-upgrade.ts",
        edit: (source) =>
          source.replace(
            'import { unscopedPrisma } from "@/lib/tenancy/client";',
            'import { scrypt } from "node:crypto";\nimport { unscopedPrisma } from "@/lib/tenancy/client";',
          ),
      },
    ]);
    expect(rules).toContain("R2");
  });

  it("R3 — fires when a module outside the enumerated set writes a password", async () => {
    const rules = await rulesFiring([
      {
        file: "src/actions/posts.ts",
        edit: (source) =>
          source.replace(/data:\s*\{/, 'data: { password: "whatever-this-is",'),
      },
    ]);
    expect(rules).toContain("R3");
  });

  it("R4 — fires when the policy is lowered below the floor", async () => {
    // One character, every test still green: `needsRehash` measures against
    // this constant, so lowering it makes every stored hash read as current.
    const rules = await rulesFiring([
      {
        file: PASSWORD_FILE,
        edit: (source) =>
          source.replace(
            /PASSWORD_HASH_POLICY: ScryptParameters = \{ ln: \d+/,
            "PASSWORD_HASH_POLICY: ScryptParameters = { ln: 10",
          ),
      },
    ]);
    expect(rules).toContain("R4");
  });

  it("P1 — fires when the hash stops carrying its parameters", async () => {
    const rules = await rulesFiring([
      {
        file: PASSWORD_FILE,
        edit: (source) =>
          source.replace(
            "  return `$scrypt$${fields}$${toB64(salt)}$${toB64(key)}`;",
            '  return `${key.toString("hex")}.${salt.toString("hex")}`;',
          ),
      },
    ]);
    expect(rules).toContain("P1");
  });

  it("P2 — fires when the previous format stops verifying", async () => {
    // Deleting the legacy branch is invisible in a fresh database and locks
    // out every account older than this change in a real one.
    const rules = await rulesFiring([
      {
        file: PASSWORD_FILE,
        edit: (source) =>
          source.replace(
            "  const legacy = LEGACY_PATTERN.exec(encoded);",
            '  const legacy = null as ReturnType<RegExp["exec"]>;',
          ),
      },
    ]);
    expect(rules).toContain("P2");
  });

  it("P3 — fires when maxmem goes back to Node's default", async () => {
    // The second thing that pinned the old module's cost, and the one a
    // format change on its own does not fix.
    const rules = await rulesFiring([
      {
        file: PASSWORD_FILE,
        edit: (source) =>
          source.replace(
            /    maxmem: workingSetBytes\(params\) \+ 1024 \* 1024,/,
            "    maxmem: 32 * 1024 * 1024,",
          ),
      },
    ]);
    expect(rules).toContain("P3");
  });

  it("P4 — fires when the working-set ceiling is removed", async () => {
    const rules = await rulesFiring([
      {
        file: PASSWORD_FILE,
        edit: (source) =>
          source.replace(
            "  return workingSetBytes(params) <= MAX_WORKING_SET_BYTES;",
            "  return true;",
          ),
      },
    ]);
    // Either it verifies the bomb (it does not, the key is wrong) or it throws
    // trying to allocate. Both are P4; what must not happen is silence.
    expect(rules).toContain("P4");
  }, 30_000);
});

describe("parameterLiteral", () => {
  it("reads the policy out of the live module", () => {
    const policy = parameterLiteral(
      readFileSync(path.join(REPO, PASSWORD_FILE), "utf8"),
      "PASSWORD_HASH_POLICY",
    );

    expect(policy).not.toBeNull();
    expect(policy?.ln).toBeGreaterThanOrEqual(POLICY_FLOOR.ln);
  });

  it("returns null when there is no such literal", () => {
    expect(parameterLiteral("const x = 1;", "PASSWORD_HASH_POLICY")).toBe(null);
  });
});

describe("withoutComments", () => {
  it("does not let prose satisfy a rule", () => {
    expect(
      withoutComments("// await upgradePasswordHash(x)\nconst a = 1;"),
    ).not.toContain("upgradePasswordHash");
  });

  it("leaves a URL in a string alone", () => {
    expect(withoutComments('const u = "https://example.com/x";')).toContain(
      "https://example.com/x",
    );
  });
});
