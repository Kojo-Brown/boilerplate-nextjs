import { describe, it, expect } from "vitest";
import {
  CSP_HEADER,
  CSP_REPORT_ONLY_HEADER,
  INTERNAL_CSP_HEADERS,
  NONCE_HEADER,
  allowsExternalScript,
  allowsInlineScript,
  buildPolicy,
  directives,
  hashSource,
  mintNonce,
  parsePolicy,
  scriptSources,
  serialise,
} from "@/lib/security/csp";
import type { PolicyInput } from "@/lib/security/csp";

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    nonce: "TestNonceAAAAAAAAAAAAA==",
    mode: "production",
    secure: true,
    thirdParty: {},
    ...overrides,
  };
}

function sources(policy: string, directive: string): string[] {
  return parsePolicy(policy).get(directive) ?? [];
}

describe("mintNonce", () => {
  it("is 128 bits of base64", () => {
    // 16 bytes → 24 characters with one padding pair.
    expect(mintNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it("does not repeat", () => {
    const minted = new Set(Array.from({ length: 200 }, () => mintNonce()));
    expect(minted.size).toBe(200);
  });

  it("matches the character class Next parses a nonce with", () => {
    // `CSP_NONCE_SOURCE_REGEX` in next/dist/server/app-render. A nonce Next
    // cannot parse is a nonce it never applies, and nothing would fail loudly.
    const nextsRegex = /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/;
    for (let i = 0; i < 50; i++) {
      expect(`'nonce-${mintNonce()}'`).toMatch(nextsRegex);
    }
  });
});

describe("the strict policy", () => {
  it("carries the nonce in script-src, where Next looks for it", () => {
    const policy = buildPolicy(input({ nonce: "abc123==" }));
    expect(sources(policy, "script-src")).toContain("'nonce-abc123=='");
  });

  it("keeps 'self' in script-src", () => {
    // The prerendered documents load 13–18 `/_next/static/…` scripts with no
    // nonce on them. This is the source that allows them.
    expect(sources(buildPolicy(input()), "script-src")).toContain("'self'");
  });

  it("has no 'unsafe-inline', 'unsafe-eval' or 'strict-dynamic'", () => {
    const script = sources(buildPolicy(input()), "script-src");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("'strict-dynamic'");
  });

  it("adds one 'sha256-…' source per shell digest", () => {
    const policy = buildPolicy(input({ shellHashes: ["AAA=", "BBB="] }));
    expect(sources(policy, "script-src")).toContain("'sha256-AAA='");
    expect(sources(policy, "script-src")).toContain("'sha256-BBB='");
  });

  it("locks down the directives that have no other guard", () => {
    const policy = buildPolicy(input());
    expect(sources(policy, "object-src")).toEqual(["'none'"]);
    expect(sources(policy, "base-uri")).toEqual(["'none'"]);
    expect(sources(policy, "frame-ancestors")).toEqual(["'none'"]);
    expect(sources(policy, "form-action")).toEqual(["'self'"]);
    expect(sources(policy, "default-src")).toEqual(["'self'"]);
  });

  it("allows inline styles, and says so only for styles", () => {
    // React renders `style={{…}}` as an attribute, which cannot carry a nonce.
    expect(sources(buildPolicy(input()), "style-src")).toEqual([
      "'self'",
      "'unsafe-inline'",
    ]);
  });

  it("upgrades insecure requests only on an https request", () => {
    expect(buildPolicy(input({ secure: true }))).toContain(
      "upgrade-insecure-requests",
    );
    expect(buildPolicy(input({ secure: false }))).not.toContain(
      "upgrade-insecure-requests",
    );
  });
});

describe("the development policy", () => {
  it("allows eval and the HMR socket, and production does not", () => {
    const dev = buildPolicy(input({ mode: "development" }));
    expect(sources(dev, "script-src")).toContain("'unsafe-eval'");
    expect(sources(dev, "connect-src")).toContain("ws:");

    const prod = buildPolicy(input({ mode: "production" }));
    expect(sources(prod, "script-src")).not.toContain("'unsafe-eval'");
    expect(sources(prod, "connect-src")).not.toContain("ws:");
  });
});

describe("a document Next re-renders at runtime", () => {
  const regenerating = input({
    documentRegenerates: true,
    nonce: undefined,
    shellHashes: ["AAA="],
  });

  it("falls back to 'unsafe-inline'", () => {
    expect(sources(buildPolicy(regenerating), "script-src")).toEqual([
      "'self'",
      "'unsafe-inline'",
    ]);
  });

  it("drops the digests, which would make 'unsafe-inline' inert", () => {
    // A CSP3 browser ignores `'unsafe-inline'` as soon as a nonce or a hash is
    // present, so keeping either alongside it would refuse every inline script
    // in a document that has no nonce — the outage, reached the long way.
    const script = sources(buildPolicy(regenerating), "script-src");
    expect(script.some((source) => source.startsWith("'sha256-"))).toBe(false);
    expect(script.some((source) => source.startsWith("'nonce-"))).toBe(false);
  });

  it("changes nothing else about the policy", () => {
    const strict = parsePolicy(buildPolicy(input()));
    const relaxed = parsePolicy(buildPolicy(regenerating));

    for (const [name, value] of strict) {
      if (name === "script-src") continue;
      expect(relaxed.get(name)).toEqual(value);
    }
  });
});

describe("third-party origins", () => {
  it("are absent until the deployment configures them", () => {
    expect(sources(buildPolicy(input()), "script-src")).not.toContain(
      "https://plausible.io",
    );
    expect(sources(buildPolicy(input()), "connect-src")).not.toContain(
      "https://plausible.io",
    );
  });

  it("appear in script-src and connect-src once configured", () => {
    const policy = buildPolicy(
      input({ thirdParty: { plausibleDomain: "example.com" } }),
    );
    expect(sources(policy, "script-src")).toContain("https://plausible.io");
    expect(sources(policy, "connect-src")).toContain("https://plausible.io");
  });

  it("puts the facade's origin in frame-src and the image hosts in img-src", () => {
    const policy = buildPolicy(input());
    expect(sources(policy, "frame-src")).toContain(
      "https://www.youtube-nocookie.com",
    );
    expect(sources(policy, "img-src")).toContain("https://images.unsplash.com");
    // `**.googleusercontent.com` is next.config's remotePattern syntax; CSP
    // takes one star.
    expect(sources(policy, "img-src")).toContain(
      "https://*.googleusercontent.com",
    );
  });

  it("keeps data: and blob: for placeholders and upload previews", () => {
    const img = sources(buildPolicy(input()), "img-src");
    expect(img).toContain("data:");
    expect(img).toContain("blob:");
  });
});

describe("serialise / parsePolicy", () => {
  it("writes a valueless directive without a trailing space", () => {
    expect(
      serialise([{ name: "upgrade-insecure-requests", sources: [] }]),
    ).toBe("upgrade-insecure-requests");
  });

  it("round-trips the policy it builds", () => {
    const list = directives(input());
    const parsed = parsePolicy(serialise(list));
    for (const directive of list) {
      expect(parsed.get(directive.name)).toEqual([...directive.sources]);
    }
  });

  it("ignores empty segments", () => {
    expect([...parsePolicy("default-src 'self';; ").keys()]).toEqual([
      "default-src",
    ]);
  });
});

describe("scriptSources fallback order", () => {
  it("prefers script-src-elem, then script-src, then default-src", () => {
    expect(
      scriptSources(
        parsePolicy(
          "default-src 'none'; script-src 'self'; script-src-elem 'a'",
        ),
      ),
    ).toEqual(["'a'"]);
    expect(
      scriptSources(parsePolicy("default-src 'none'; script-src 'self'")),
    ).toEqual(["'self'"]);
    expect(scriptSources(parsePolicy("default-src 'self'"))).toEqual([
      "'self'",
    ]);
    expect(scriptSources(parsePolicy("img-src 'self'"))).toBeUndefined();
  });
});

describe("allowsExternalScript", () => {
  const policy = parsePolicy(buildPolicy(input()));

  it("allows a same-origin chunk under 'self'", () => {
    expect(allowsExternalScript(policy, "/_next/static/chunks/main.js")).toBe(
      true,
    );
  });

  it("refuses an off-origin script the catalogue does not list", () => {
    expect(allowsExternalScript(policy, "https://evil.test/x.js")).toBe(false);
  });

  it("allows a configured third-party origin", () => {
    const configured = parsePolicy(
      buildPolicy(input({ thirdParty: { plausibleDomain: "example.com" } })),
    );
    expect(
      allowsExternalScript(configured, "https://plausible.io/js/script.js"),
    ).toBe(true);
  });

  it("matches a subdomain wildcard on the dot, not the suffix", () => {
    const wildcard = parsePolicy("script-src https://*.example.com");
    expect(allowsExternalScript(wildcard, "https://a.example.com/x.js")).toBe(
      true,
    );
    expect(allowsExternalScript(wildcard, "https://notexample.com/x.js")).toBe(
      false,
    );
  });

  it("refuses a parser-inserted tag once 'strict-dynamic' is present", () => {
    // The measurement the whole design rests on, as an assertion: with
    // `'strict-dynamic'` every host source is ignored, so the prerendered
    // documents' own chunks are refused.
    const strictDynamic = parsePolicy(
      "script-src 'self' 'nonce-abc' 'strict-dynamic'",
    );
    expect(
      allowsExternalScript(strictDynamic, "/_next/static/chunks/main.js"),
    ).toBe(false);
    expect(
      allowsExternalScript(strictDynamic, "/_next/static/chunks/main.js", {
        nonce: "abc",
      }),
    ).toBe(true);
  });

  it("treats a policy with no script directive as unrestricted", () => {
    expect(allowsExternalScript(parsePolicy("img-src 'self'"), "/x.js")).toBe(
      true,
    );
  });

  it("refuses a malformed URL rather than throwing", () => {
    expect(allowsExternalScript(policy, "ht!tp://%%%")).toBe(false);
  });
});

describe("allowsInlineScript", () => {
  it("allows a script whose digest is in the policy", () => {
    const policy = parsePolicy(buildPolicy(input({ shellHashes: ["AAA="] })));
    expect(allowsInlineScript(policy, "AAA=")).toBe(true);
    expect(allowsInlineScript(policy, "BBB=")).toBe(false);
  });

  it("allows a script carrying the policy's nonce", () => {
    const policy = parsePolicy(buildPolicy(input({ nonce: "abc" })));
    expect(allowsInlineScript(policy, "BBB=", { nonce: "abc" })).toBe(true);
  });

  it("honours 'unsafe-inline' only when no nonce or hash is present", () => {
    expect(
      allowsInlineScript(
        parsePolicy("script-src 'self' 'unsafe-inline'"),
        "AAA=",
      ),
    ).toBe(true);
    expect(
      allowsInlineScript(
        parsePolicy("script-src 'self' 'unsafe-inline' 'nonce-abc'"),
        "AAA=",
      ),
    ).toBe(false);
    expect(
      allowsInlineScript(
        parsePolicy("script-src 'self' 'unsafe-inline' 'sha256-BBB='"),
        "AAA=",
      ),
    ).toBe(false);
  });
});

describe("hashSource", () => {
  it("quotes the digest the way CSP wants it", () => {
    expect(hashSource("AAA=")).toBe("'sha256-AAA='");
  });
});

describe("the headers this module owns", () => {
  it("names both policy headers and the nonce copy", () => {
    // All three are stripped from inbound requests. The enforcing *and*
    // report-only headers matter: Next reads the nonce out of either one, so a
    // client-supplied report-only policy is just as good an injection vector.
    expect([...INTERNAL_CSP_HEADERS]).toEqual([
      CSP_HEADER,
      CSP_REPORT_ONLY_HEADER,
      NONCE_HEADER,
    ]);
  });
});
