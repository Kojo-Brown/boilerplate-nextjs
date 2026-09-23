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
  declaredClaimNames,
  rotationCallSites,
} from "./assert-session-hardening";

const REPO = process.cwd();

/**
 * A copy of the real sources, which the caller then breaks in one specific way.
 *
 * Copying the whole of `src/` rather than writing fixtures by hand is what
 * makes each case below a statement about *this* repository: the gate has to
 * pass on the tree as it stands and fail on the tree with one line changed. A
 * hand-written fixture would only prove the regex works.
 */
function withBrokenTree(
  edits: { file: string; edit: (source: string) => string }[],
): string {
  const root = mkdtempSync(path.join(tmpdir(), "session-gate-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });

  for (const { file, edit } of edits) {
    const target = path.join(root, file);
    const source = readFileSync(target, "utf8");
    writeFileSync(target, edit(source), "utf8");
  }
  return root;
}

describe("the gate passes on this repository", () => {
  it("finds nothing", () => {
    expect(check(REPO)).toEqual([]);
  });
});

describe("R1 — claim names jose overwrites", () => {
  it("fails when a claim is renamed to jti", () => {
    // The regression that actually happened. Renaming `tid` to the standard
    // abbreviation looks like a tidy-up and destroys reuse detection: every
    // request would present an id the registry has never seen.
    const root = withBrokenTree([
      {
        file: "src/lib/auth/claims.ts",
        edit: (source) => source.replace(/^  tid: string;$/m, "  jti: string;"),
      },
    ]);

    const findings = check(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "R1" });
    expect(findings[0]!.message).toContain("jti");
  });

  it.each(["iat", "exp", "sub"])("fails on the reserved claim %s", (name) => {
    const root = withBrokenTree([
      {
        file: "src/lib/auth/claims.ts",
        edit: (source) =>
          source.replace(/^  sat: number;$/m, `  ${name}: number;`),
      },
    ]);

    expect(check(root).some((finding) => finding.rule === "R1")).toBe(true);
  });

  it("reads the names off the interface", () => {
    expect(
      declaredClaimNames(
        "export interface SessionClaims {\n  sid: string;\n  tid: string;\n}",
      ),
    ).toEqual(["sid", "tid"]);
  });

  it("is not fooled by the word appearing in prose", () => {
    // Every one of these files explains why `jti` cannot be used. A gate that
    // matched its own documentation would fail on the code it describes.
    expect(
      declaredClaimNames(
        "/** never use jti: string; here */\nexport interface SessionClaims {\n  tid: string;\n}",
      ),
    ).toEqual(["tid"]);
  });
});

describe("R2 — rotation confined to the proxy", () => {
  it("fails when another module rotates", () => {
    const root = withBrokenTree([
      {
        file: "src/auth.ts",
        edit: (source) =>
          source.replace(
            "{ token, user, mayRotate: false }",
            "{ token, user, mayRotate: true }",
          ),
      },
    ]);

    const findings = check(root).filter((finding) => finding.rule === "R2");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe("src/auth.ts");
  });

  it("ignores the phrase inside a comment", () => {
    expect(
      rotationCallSites([
        { relativePath: "src/x.ts", text: "// mayRotate: true is proxy-only" },
        { relativePath: "src/y.ts", text: "/* mayRotate: true */" },
      ]),
    ).toEqual([]);
  });

  it("does not flag the proxy itself", () => {
    expect(
      rotationCallSites([
        { relativePath: "src/proxy.ts", text: "mayRotate: true" },
      ]),
    ).toEqual([]);
  });
});

describe("R3 — the proxy keeps the hardened callback", () => {
  it("fails when the proxy goes back to a bare NextAuth(authConfig)", () => {
    // The silent one: this builds, serves every page, and never rotates.
    const root = withBrokenTree([
      {
        file: "src/proxy.ts",
        edit: (source) =>
          source.replace(
            /const \{ auth \} = NextAuth\(\{[\s\S]*?\n\}\);/,
            "const { auth } = NextAuth(authConfig);",
          ),
      },
    ]);

    const rules = check(root).map((finding) => finding.rule);
    expect(rules).toContain("R3");
  });
});

describe("R4 — the cookie keeps its flags", () => {
  it.each([
    ["httpOnly", /httpOnly: true/, "httpOnly: false"],
    ["sameSite", /sameSite: "lax" as const/, 'sameSite: "none" as const'],
    ["secure", /secure: USE_SECURE_COOKIES/, "secure: false"],
  ])("fails when %s is weakened", (_label, pattern, replacement) => {
    const root = withBrokenTree([
      {
        file: "src/auth.config.ts",
        edit: (source) => source.replace(pattern, replacement),
      },
    ]);

    expect(check(root).some((finding) => finding.rule === "R4")).toBe(true);
  });

  it("fails when a cookie domain is introduced", () => {
    // `__Host-` forbids it, and a browser rejects such a cookie outright — so
    // this is not a weakening, it is an outage nobody would attribute to the
    // line that caused it.
    const root = withBrokenTree([
      {
        file: "src/auth.config.ts",
        edit: (source) =>
          source.replace(
            'path: "/",',
            'path: "/",\n        domain: ".example.com",',
          ),
      },
    ]);

    expect(check(root).some((finding) => finding.rule === "R4")).toBe(true);
  });

  it("fails when the __Host- prefix is downgraded to __Secure-", () => {
    const root = withBrokenTree([
      {
        file: "src/lib/auth/deployment.ts",
        edit: (source) => source.replaceAll("__Host-", "__Secure-"),
      },
    ]);

    expect(check(root).some((finding) => finding.rule === "R4")).toBe(true);
  });
});

describe("R5 — trustHost stays paired with a pinned origin", () => {
  it("fails when the origin stops being pinned", () => {
    // Keeping `trustHost: true` while dropping the pin is the dangerous half of
    // the pair on its own: Auth.js goes back to reading x-forwarded-host.
    const root = withBrokenTree([
      {
        file: "src/lib/auth/deployment.ts",
        edit: (source) =>
          source.replace('process.env["AUTH_URL"] ??= origin;', ""),
      },
    ]);

    const findings = check(root).filter((finding) => finding.rule === "R5");
    expect(findings).toHaveLength(1);
  });

  it("says nothing when trustHost is not set", () => {
    const root = withBrokenTree([
      {
        file: "src/auth.config.ts",
        edit: (source) => source.replace("trustHost: true,", ""),
      },
      {
        file: "src/lib/auth/deployment.ts",
        edit: (source) =>
          source.replace('process.env["AUTH_URL"] ??= origin;', ""),
      },
    ]);

    expect(check(root).some((finding) => finding.rule === "R5")).toBe(false);
  });
});

describe("R6 — sign-out revokes", () => {
  it("fails when the signOut handler is removed", () => {
    const root = withBrokenTree([
      {
        file: "src/auth.ts",
        edit: (source) => source.replace(/events: \{[\s\S]*?\n  \},\n/, ""),
      },
    ]);

    expect(check(root).some((finding) => finding.rule === "R6")).toBe(true);
  });
});
