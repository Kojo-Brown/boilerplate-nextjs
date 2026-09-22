import { NextRequest } from "next/server";
import { describe, it, expect, beforeEach } from "vitest";
import {
  CSP_HEADER,
  CSP_REPORT_ONLY_HEADER,
  NONCE_HEADER,
} from "@/lib/security/csp";
import {
  applyCspHeaders,
  applyCspRequestHeaders,
  decideCsp,
  resetManifestWarning,
  stripInboundCspHeaders,
} from "@/lib/security/apply";
import { resetManifestCache } from "@/lib/security/shell-hashes";

function request(
  path = "/",
  init: { headers?: Record<string, string>; origin?: string } = {},
): NextRequest {
  return new NextRequest(`${init.origin ?? "https://example.test"}${path}`, {
    headers: new Headers(init.headers ?? {}),
  });
}

function sourcesOf(policy: string, directive: string): string[] {
  const found = policy
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .find(([name]) => name === directive);
  return found?.slice(1) ?? [];
}

beforeEach(() => {
  resetManifestWarning();
  resetManifestCache();
});

describe("decideCsp", () => {
  it("mints a nonce per call", () => {
    const first = decideCsp(request(), { shellHashes: [] });
    const second = decideCsp(request(), { shellHashes: [] });
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.policy).toContain(`'nonce-${first.nonce}'`);
  });

  it("enforces by default", () => {
    expect(decideCsp(request(), { shellHashes: [] }).header).toBe(CSP_HEADER);
  });

  it("reports instead of enforcing when CSP_REPORT_ONLY=1", () => {
    expect(
      decideCsp(request(), { shellHashes: [], reportOnly: "1" }).header,
    ).toBe(CSP_REPORT_ONLY_HEADER);
  });

  it("relaxes only for NODE_ENV=development", () => {
    const dev = decideCsp(request(), {
      shellHashes: [],
      nodeEnv: "development",
    });
    expect(sourcesOf(dev.policy, "script-src")).toContain("'unsafe-eval'");

    // A test run is not a dev server: it gets the policy worth asserting against.
    for (const nodeEnv of ["test", "production", undefined]) {
      const other = decideCsp(request(), { shellHashes: [], nodeEnv });
      expect(sourcesOf(other.policy, "script-src")).not.toContain(
        "'unsafe-eval'",
      );
    }
  });

  it("carries the digests it is given", () => {
    const decision = decideCsp(request(), { shellHashes: ["AAA="] });
    expect(sourcesOf(decision.policy, "script-src")).toContain("'sha256-AAA='");
  });

  it("withholds the nonce for a document Next re-renders at runtime", () => {
    // Not merely left out of the policy: withheld, so nothing forwards it to the
    // render that repopulates the cache. See PolicyInput.documentRegenerates.
    const decision = decideCsp(request("/blog"), {
      shellHashes: ["AAA="],
      documentRegenerates: true,
    });

    expect(decision.nonce).toBeUndefined();
    expect(sourcesOf(decision.policy, "script-src")).toEqual([
      "'self'",
      "'unsafe-inline'",
    ]);
  });

  it("upgrades insecure requests behind a terminating proxy", () => {
    const plain = decideCsp(request("/", { origin: "http://example.test" }), {
      shellHashes: [],
    });
    expect(plain.policy).not.toContain("upgrade-insecure-requests");

    const forwarded = decideCsp(
      request("/", {
        origin: "http://example.test",
        headers: { "x-forwarded-proto": "https" },
      }),
      { shellHashes: [] },
    );
    expect(forwarded.policy).toContain("upgrade-insecure-requests");
  });

  it("warns once and degrades to report-only when the manifest is missing", () => {
    const warnings: string[] = [];
    const warn = (message: string): void => {
      warnings.push(message);
    };

    // `shellHashes` left out so the manifest is actually looked for, and
    // NODE_ENV=production so its absence is a problem rather than the norm.
    const missing = {
      nodeEnv: "production",
      warn,
      readManifest: () => undefined,
    };
    const first = decideCsp(request(), missing);
    const second = decideCsp(request(), missing);

    expect(first.header).toBe(CSP_REPORT_ONLY_HEADER);
    expect(second.header).toBe(CSP_REPORT_ONLY_HEADER);
    // A per-request log line for a per-deployment mistake is how a log stops
    // being read.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("csp-shell-hashes.json");
  });

  it("does not look for a manifest outside production", () => {
    const warnings: string[] = [];
    let reads = 0;
    const decision = decideCsp(request(), {
      nodeEnv: "development",
      warn: (message) => warnings.push(message),
      readManifest: () => {
        reads += 1;
        return undefined;
      },
    });

    expect(reads).toBe(0);

    // `next dev` prerenders nothing: every document is rendered on demand and
    // nonced, so there is nothing for a digest to authorise.
    expect(decision.header).toBe(CSP_HEADER);
    expect(warnings).toEqual([]);
  });
});

describe("applyCspRequestHeaders", () => {
  it("sets the policy Next reads the nonce out of, plus the x-nonce copy", () => {
    const decision = decideCsp(request(), { shellHashes: [] });
    const headers = applyCspRequestHeaders(new Headers(), decision);

    expect(headers.get(CSP_HEADER)).toBe(decision.policy);
    expect(headers.get(NONCE_HEADER)).toBe(decision.nonce);
  });

  it("sets the report-only header in report-only mode, for the same reason", () => {
    // Next parses the nonce out of either header, so report-only still nonces
    // the render — the policy is complete and enforced by nobody.
    const decision = decideCsp(request(), {
      shellHashes: [],
      reportOnly: "1",
    });
    const headers = applyCspRequestHeaders(new Headers(), decision);

    expect(headers.get(CSP_REPORT_ONLY_HEADER)).toBe(decision.policy);
    expect(headers.get(CSP_HEADER)).toBeNull();
  });

  it("replaces a client-supplied policy instead of forwarding it", () => {
    // The injection this closes: `app-render` reads the *request's* policy and
    // stamps its nonce on every script it writes, so a forwarded one is an
    // attacker-chosen nonce in the document.
    const inbound = new Headers({
      [CSP_HEADER]: "script-src 'nonce-attackerChosen'",
      [CSP_REPORT_ONLY_HEADER]: "script-src 'nonce-alsoMine'",
      [NONCE_HEADER]: "attackerChosen",
    });

    const decision = decideCsp(request(), { shellHashes: [] });
    const headers = applyCspRequestHeaders(inbound, decision);

    expect(headers.get(CSP_HEADER)).toBe(decision.policy);
    expect(headers.get(CSP_HEADER)).not.toContain("attackerChosen");
    expect(headers.get(CSP_REPORT_ONLY_HEADER)).toBeNull();
    expect(headers.get(NONCE_HEADER)).toBe(decision.nonce);
  });

  it("sets no x-nonce when the nonce was withheld", () => {
    const decision = decideCsp(request("/blog"), {
      shellHashes: [],
      documentRegenerates: true,
    });
    const headers = applyCspRequestHeaders(
      new Headers({ [NONCE_HEADER]: "stale" }),
      decision,
    );

    expect(headers.get(NONCE_HEADER)).toBeNull();
  });
});

describe("stripInboundCspHeaders", () => {
  it("deletes every header this module owns", () => {
    const headers = stripInboundCspHeaders(
      new Headers({
        [CSP_HEADER]: "x",
        [CSP_REPORT_ONLY_HEADER]: "y",
        [NONCE_HEADER]: "z",
        "x-keep-me": "kept",
      }),
    );

    expect(headers.get(CSP_HEADER)).toBeNull();
    expect(headers.get(CSP_REPORT_ONLY_HEADER)).toBeNull();
    expect(headers.get(NONCE_HEADER)).toBeNull();
    expect(headers.get("x-keep-me")).toBe("kept");
  });
});

describe("applyCspHeaders", () => {
  it("puts the policy on the response and returns the same object", () => {
    const decision = decideCsp(request(), { shellHashes: [] });
    const response = new Response(null);

    expect(applyCspHeaders(response, decision)).toBe(response);
    expect(response.headers.get(CSP_HEADER)).toBe(decision.policy);
  });
});
