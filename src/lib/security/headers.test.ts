import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import {
  HSTS_HEADER,
  HSTS_MAX_AGE_S,
  STATIC_HARDENING_HEADERS,
  applyHardeningHeaders,
  decideHardeningHeaders,
  hstsValue,
} from "@/lib/security/headers";

function makeRequest(
  url: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(new Request(url, { headers }));
}

describe("decideHardeningHeaders", () => {
  it("always sends nosniff, DENY, a referrer policy and a permissions policy", () => {
    const headers = decideHardeningHeaders(
      makeRequest("http://localhost:3000/"),
    );

    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
  });

  it("denies every powerful feature with an empty allowlist, not a self one", () => {
    // `camera=(self)` would still let an injected script on this origin prompt,
    // which is the case the header is here for. `()` is the empty list.
    const policy = STATIC_HARDENING_HEADERS["permissions-policy"]!;

    for (const feature of policy.split(", ")) {
      expect(feature, feature).toMatch(/^[a-z-]+=\(\)$/);
    }
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
      expect(policy, feature).toContain(`${feature}=()`);
    }
  });

  it("withholds HSTS from a plain-HTTP request", () => {
    // Not a browser-visible difference — HSTS is ignored over plain HTTP — but a
    // developer-visible one: sent on http://localhost it would pin a hostname
    // shared with every other project on the machine.
    const headers = decideHardeningHeaders(
      makeRequest("http://localhost:3000/"),
    );

    expect(headers[HSTS_HEADER]).toBeUndefined();
  });

  it("sends HSTS on an https request", () => {
    const headers = decideHardeningHeaders(makeRequest("https://app.example/"));

    expect(headers[HSTS_HEADER]).toBe(
      `max-age=${HSTS_MAX_AGE_S}; includeSubDomains`,
    );
  });

  it("sends HSTS behind a proxy that terminated TLS", () => {
    const headers = decideHardeningHeaders(
      makeRequest("http://app.example/", { "x-forwarded-proto": "https" }),
    );

    expect(headers[HSTS_HEADER]).toBe(hstsValue());
  });

  it("does not ask for preload, which is not a boilerplate's decision", () => {
    // Being on the preload list takes months to undo and covers every
    // subdomain. A default must not make that choice for a deployment.
    expect(hstsValue()).not.toContain("preload");
  });

  it("asks for at least the two years the preload list requires", () => {
    // Not because this asks to be preloaded, but because a shorter max-age is a
    // window in which a downgrade still works, and two years is the settled
    // number.
    expect(HSTS_MAX_AGE_S).toBeGreaterThanOrEqual(63072000);
    expect(hstsValue()).toContain("includeSubDomains");
  });
});

describe("applyHardeningHeaders", () => {
  it("puts every decided header on the response", () => {
    const response = applyHardeningHeaders(
      new Response("ok"),
      makeRequest("https://app.example/"),
    );

    for (const [name, value] of Object.entries(STATIC_HARDENING_HEADERS)) {
      expect(response.headers.get(name), name).toBe(value);
    }
    expect(response.headers.get(HSTS_HEADER)).toBe(hstsValue());
  });

  it("replaces an upstream value rather than appending a second one", () => {
    // `X-Frame-Options: DENY, SAMEORIGIN` is honoured by neither value in some
    // browsers, so a header this module owns has to arrive exactly once.
    const response = applyHardeningHeaders(
      new Response("ok", { headers: { "x-frame-options": "SAMEORIGIN" } }),
      makeRequest("https://app.example/"),
    );

    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("returns the same response object, so it composes with the other appliers", () => {
    const response = new Response("ok");

    expect(
      applyHardeningHeaders(response, makeRequest("https://app.example/")),
    ).toBe(response);
  });
});
