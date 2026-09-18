import { NextRequest, NextResponse } from "next/server";
import { describe, it, expect } from "vitest";
import {
  ASSIGNMENTS_HEADER,
  EXPOSURE_HEADER,
  GEO_HEADER,
  INTERNAL_REQUEST_HEADERS,
  applyExperiments,
  carryOverHeaders,
  formatAssignments,
  formatExposure,
  resolveExperimentContext,
  sanitisedRequestHeaders,
  setCookieHeader,
} from "@/lib/experiments/edge";
import {
  ASSIGNMENT_COOKIE,
  VISITOR_COOKIE,
  cookieAttributes,
} from "@/lib/experiments/cookies";
import type { Assignment } from "@/lib/experiments/assignment";
import type { Experiment } from "@/lib/experiments/definitions";

const DEMO: Experiment = {
  id: "demo",
  salt: "s1",
  variants: [
    { id: "control", weightBasisPoints: 5_000, because: "a" },
    { id: "treatment", weightBasisPoints: 5_000, because: "b" },
  ],
  fallbackVariantId: "control",
  route: {
    path: "/demo",
    canonicalVariantId: "control",
    rewritePrefix: "/demo/v",
  },
  because: "a fixture",
};

const KNOWN_VISITOR = "0189d0aa-4b27-4d1f-9c3e-2f7f8a1b2c3d";

function makeRequest(
  path: string,
  init: {
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): NextRequest {
  const headers = new Headers(init.headers ?? {});
  const cookies = Object.entries(init.cookies ?? {});
  if (cookies.length > 0) {
    headers.set(
      "cookie",
      cookies.map(([name, value]) => `${name}=${value}`).join("; "),
    );
  }
  return new NextRequest(new URL(path, "http://localhost:3000"), { headers });
}

const experiments = [DEMO];

function contextFor(
  path: string,
  init: Parameters<typeof makeRequest>[1] = {},
  mintId = () => KNOWN_VISITOR,
) {
  const request = makeRequest(path, init);
  return {
    request,
    context: resolveExperimentContext(request, { experiments, mintId }),
  };
}

describe("resolveExperimentContext — the visitor id", () => {
  it("mints one when there is no cookie", () => {
    const { context } = contextFor("/demo");
    expect(context.isNewVisitor).toBe(true);
    expect(context.visitorId).toBe(KNOWN_VISITOR);
    expect(context.cookiesNeedWriting).toBe(true);
  });

  it("keeps a well-formed one from the cookie", () => {
    const { context } = contextFor("/demo", {
      cookies: { [VISITOR_COOKIE]: KNOWN_VISITOR },
    });
    expect(context.isNewVisitor).toBe(false);
    expect(context.visitorId).toBe(KNOWN_VISITOR);
  });

  it("replaces a cookie value it did not mint", () => {
    const { context } = contextFor("/demo", {
      cookies: { [VISITOR_COOKIE]: "not-a-uuid" },
    });
    expect(context.isNewVisitor).toBe(true);
    expect(context.visitorId).toBe(KNOWN_VISITOR);
  });

  it("ignores assignments belonging to a replaced id", () => {
    // The arms in that cookie were derived from an id that is no longer this
    // visitor's, so honouring them would carry an arm across a re-bucket.
    const { context } = contextFor("/demo", {
      cookies: {
        [VISITOR_COOKIE]: "bogus",
        [ASSIGNMENT_COOKIE]: "demo:treatment",
      },
    });
    expect(context.assignments[0]?.source).toBe("hash");
  });
});

describe("resolveExperimentContext — cookie writing", () => {
  it("does not rewrite cookies that already say the right thing", () => {
    const first = contextFor("/demo").context;
    const { context } = contextFor("/demo", {
      cookies: {
        [VISITOR_COOKIE]: KNOWN_VISITOR,
        [ASSIGNMENT_COOKIE]: first.cookieValue,
      },
    });
    expect(context.cookiesNeedWriting).toBe(false);
  });

  it("rewrites when the stored assignments disagree", () => {
    const { context } = contextFor("/demo", {
      cookies: {
        [VISITOR_COOKIE]: KNOWN_VISITOR,
        [ASSIGNMENT_COOKIE]: "retired:arm",
      },
    });
    expect(context.cookiesNeedWriting).toBe(true);
  });
});

describe("resolveExperimentContext — non-participating paths", () => {
  it("reports a route handler as not participating", () => {
    const { context } = contextFor("/api/health");
    expect(context.participating).toBe(false);
    expect(context.assignments).toEqual([]);
    expect(context.cookiesNeedWriting).toBe(false);
    expect(context.rewrite).toBeUndefined();
  });
});

describe("resolveExperimentContext — geo", () => {
  it("reads a trusted platform header", () => {
    const { context } = contextFor("/demo", {
      headers: { "x-vercel-ip-country": "de" },
    });
    expect(context.geo.country).toBe("DE");
  });

  it("does not read a client-supplied geo header by default", () => {
    const { context } = contextFor("/demo", {
      headers: { [GEO_HEADER]: "DE" },
    });
    expect(context.geo.country).toBe("ZZ");
  });
});

describe("resolveExperimentContext — routing", () => {
  it("produces a rewrite for a non-canonical arm", () => {
    const { context } = contextFor("/demo", {
      cookies: {
        [VISITOR_COOKIE]: KNOWN_VISITOR,
        [ASSIGNMENT_COOKIE]: "demo:treatment",
      },
    });
    expect(context.rewrite?.to).toBe("/demo/v/treatment");
  });

  it("produces none for the canonical arm", () => {
    const { context } = contextFor("/demo", {
      cookies: {
        [VISITOR_COOKIE]: KNOWN_VISITOR,
        [ASSIGNMENT_COOKIE]: "demo:control",
      },
    });
    expect(context.rewrite).toBeUndefined();
  });

  it("reports the canonical path it is on", () => {
    expect(contextFor("/demo").context.canonicalPath).toBe("/demo");
    expect(contextFor("/other").context.canonicalPath).toBeUndefined();
  });

  it("honours an override from the query string", () => {
    const { context } = contextFor("/demo?bkt_demo=treatment");
    expect(context.rewrite?.to).toBe("/demo/v/treatment");
    expect(context.assignments[0]?.source).toBe("override");
  });
});

describe("header formatting", () => {
  const assignments: Assignment[] = [
    { experimentId: "a", variantId: "one", source: "hash", exposed: true },
    { experimentId: "b", variantId: "two", source: "override", exposed: false },
  ];

  it("reports every assignment with its source to the application", () => {
    expect(formatAssignments(assignments)).toBe("a:one:hash|b:two:override");
  });

  it("reports only measured assignments as exposure", () => {
    expect(formatExposure(assignments)).toBe("a:one");
  });

  it("formats nothing as the empty string", () => {
    expect(formatAssignments([])).toBe("");
    expect(formatExposure([])).toBe("");
  });
});

describe("sanitisedRequestHeaders", () => {
  it("strips client-supplied copies of every internal header", () => {
    // Without this a caller could hand the application any assignment it liked:
    // Next merges proxy headers and client headers into one object, and nothing
    // downstream can tell them apart.
    const { request, context } = contextFor("/demo", {
      headers: {
        [ASSIGNMENTS_HEADER]: "admin-ui:on:hash",
        [GEO_HEADER]: "US",
      },
    });
    const headers = sanitisedRequestHeaders(request, context);
    expect(headers.get(ASSIGNMENTS_HEADER)).not.toContain("admin-ui");
    expect(headers.get(GEO_HEADER)).toBe("ZZ");
  });

  it("strips them on paths that take no part in bucketing", () => {
    const { request, context } = contextFor("/api/health", {
      headers: { [ASSIGNMENTS_HEADER]: "admin-ui:on:hash", [GEO_HEADER]: "US" },
    });
    const headers = sanitisedRequestHeaders(request, context);
    for (const header of INTERNAL_REQUEST_HEADERS) {
      expect(headers.get(header)).toBeNull();
    }
  });

  it("forwards the resolved country and assignments", () => {
    const { request, context } = contextFor("/demo", {
      headers: { "x-vercel-ip-country": "CA" },
    });
    const headers = sanitisedRequestHeaders(request, context);
    expect(headers.get(GEO_HEADER)).toBe("CA");
    expect(headers.get(ASSIGNMENTS_HEADER)).toMatch(
      /^demo:(control|treatment):hash$/u,
    );
  });

  it("leaves unrelated headers alone", () => {
    const { request, context } = contextFor("/demo", {
      headers: { "accept-language": "en-GB" },
    });
    expect(
      sanitisedRequestHeaders(request, context).get("accept-language"),
    ).toBe("en-GB");
  });
});

describe("setCookieHeader", () => {
  it("writes the attributes the module asks for", () => {
    expect(setCookieHeader("n", "v", cookieAttributes(true))).toBe(
      "n=v; Max-Age=31536000; Path=/; SameSite=Lax; Secure; HttpOnly",
    );
  });

  it("omits Secure over plain http", () => {
    expect(setCookieHeader("n", "v", cookieAttributes(false))).not.toContain(
      "Secure",
    );
  });
});

describe("carryOverHeaders", () => {
  it("copies ordinary headers", () => {
    const from = new Response(null, { headers: { "x-thing": "1" } });
    const to = NextResponse.next();
    carryOverHeaders(from, to);
    expect(to.headers.get("x-thing")).toBe("1");
  });

  it("copies several Set-Cookie headers as several headers", () => {
    // The iterator hands `set-cookie` back comma-joined; copying that would
    // turn two valid cookies into one malformed one.
    const from = new Response(null);
    from.headers.append("set-cookie", "a=1; Path=/");
    from.headers.append("set-cookie", "b=2; Path=/");
    const to = NextResponse.next();
    carryOverHeaders(from, to);
    expect(to.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("does not copy Next's own middleware instructions", () => {
    const from = NextResponse.next();
    expect(from.headers.get("x-middleware-next")).not.toBeNull();
    const to = NextResponse.rewrite(new URL("http://localhost:3000/x"));
    carryOverHeaders(from, to);
    expect(to.headers.get("x-middleware-next")).toBeNull();
  });
});

describe("applyExperiments", () => {
  it("rewrites to the variant path", () => {
    const { request, context } = contextFor("/demo", {
      cookies: {
        [VISITOR_COOKIE]: KNOWN_VISITOR,
        [ASSIGNMENT_COOKIE]: "demo:treatment",
      },
    });
    const response = applyExperiments(request, context, NextResponse.next());
    expect(response.headers.get("x-middleware-rewrite")).toContain(
      "/demo/v/treatment",
    );
  });

  it("keeps the query string on a rewrite, so an override survives a reload", () => {
    const { request, context } = contextFor("/demo?bkt_demo=treatment");
    const response = applyExperiments(request, context, NextResponse.next());
    expect(response.headers.get("x-middleware-rewrite")).toContain(
      "bkt_demo=treatment",
    );
  });

  it("does not rewrite the canonical arm", () => {
    const { request, context } = contextFor("/demo", {
      cookies: {
        [VISITOR_COOKIE]: KNOWN_VISITOR,
        [ASSIGNMENT_COOKIE]: "demo:control",
      },
    });
    const response = applyExperiments(request, context, NextResponse.next());
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("writes both cookies for a new visitor", () => {
    const { request, context } = contextFor("/demo");
    const cookies = applyExperiments(
      request,
      context,
      NextResponse.next(),
    ).headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith(`${VISITOR_COOKIE}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${ASSIGNMENT_COOKIE}=`))).toBe(
      true,
    );
  });

  it("writes no cookies when nothing changed", () => {
    const first = contextFor("/demo").context;
    const { request, context } = contextFor("/demo", {
      cookies: {
        [VISITOR_COOKIE]: KNOWN_VISITOR,
        [ASSIGNMENT_COOKIE]: first.cookieValue,
      },
    });
    expect(
      applyExperiments(
        request,
        context,
        NextResponse.next(),
      ).headers.getSetCookie(),
    ).toEqual([]);
  });

  it("writes no cookies on a route handler", () => {
    const { request, context } = contextFor("/api/health");
    expect(
      applyExperiments(
        request,
        context,
        NextResponse.next(),
      ).headers.getSetCookie(),
    ).toEqual([]);
  });

  it("sets no Vary, because Next discards it", () => {
    // Not an omission. Next writes its own Vary on every App Router response
    // and that value replaces whatever came before it, so a `Vary: Cookie`
    // here would read like a protection and never reach a cache. The shared
    // cache is kept off the canonical path by Cache-Control instead — see
    // `@/lib/experiments/cache`.
    const { request, context } = contextFor("/demo");
    expect(
      applyExperiments(request, context, NextResponse.next()).headers.get(
        "vary",
      ),
    ).toBeNull();
  });

  it("reports exposure on the canonical path", () => {
    const { request, context } = contextFor("/demo");
    expect(
      applyExperiments(request, context, NextResponse.next()).headers.get(
        EXPOSURE_HEADER,
      ),
    ).toMatch(/^demo:(control|treatment)$/u);
  });

  it("reports no exposure for a forced arm", () => {
    const { request, context } = contextFor("/demo?bkt_demo=treatment");
    expect(
      applyExperiments(request, context, NextResponse.next()).headers.get(
        EXPOSURE_HEADER,
      ),
    ).toBeNull();
  });

  it("leaves a refusal alone but still sets the cookies", () => {
    // Rewriting a redirect would serve the variant page to a request the
    // session gate just declined; dropping the cookie would mint a new visitor
    // for everyone who signs in.
    const { request, context } = contextFor("/demo");
    const redirect = NextResponse.redirect(
      new URL("http://localhost:3000/login"),
    );
    const response = applyExperiments(request, context, redirect);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(response.headers.getSetCookie().length).toBe(2);
  });

  it("keeps a cookie the session gate set", () => {
    const { request, context } = contextFor("/demo");
    const gated = NextResponse.next();
    gated.headers.append("set-cookie", "session=abc; Path=/");
    const cookies = applyExperiments(
      request,
      context,
      gated,
    ).headers.getSetCookie();
    expect(cookies).toContain("session=abc; Path=/");
    expect(cookies.length).toBe(3);
  });
});
