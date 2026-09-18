import { NextRequest, NextResponse } from "next/server";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextFetchEvent } from "next/server";
import {
  authConfig,
  PROTECTED_PREFIXES,
  ADMIN_PREFIXES,
  AUTH_PAGES,
} from "@/auth.config";
import { ASSIGNMENT_COOKIE, VISITOR_COOKIE } from "@/lib/experiments/cookies";

/**
 * The session gate, stubbed.
 *
 * `NextAuth(authConfig)` resolves providers and reads secrets at module scope,
 * which is not what the proxy tests below are about: the question there is the
 * *order* of the two concerns in `src/proxy.ts` and which requests reach the
 * gate at all. The stub records that it was called and answers with a plain
 * `next()`. It does not affect the `authorized` tests in this file — those call
 * the callback in `@/auth.config` directly, and that module imports nothing
 * from `next-auth` but a type.
 */
const sessionGate = vi.fn<() => Response | undefined>(() => undefined);

vi.mock("next-auth", () => ({
  default: () => ({ auth: () => sessionGate }),
}));

const { default: proxy, config } = await import("@/proxy");

type AuthorizedParams = Parameters<
  NonNullable<NonNullable<typeof authConfig.callbacks>["authorized"]>
>[0];

function makeRequest(path: string, origin = "http://localhost:3000") {
  const url = new URL(path, origin);
  return { nextUrl: url } as AuthorizedParams["request"];
}

function makeSession(
  role: "USER" | "ADMIN" = "USER",
): AuthorizedParams["auth"] {
  return {
    user: { id: "user-1", email: "user@example.com", name: "Test User", role },
    expires: new Date(Date.now() + 3600 * 1000).toISOString(),
  };
}

const authorized = authConfig.callbacks!.authorized!;

describe("PROTECTED_PREFIXES / ADMIN_PREFIXES / AUTH_PAGES constants", () => {
  it("includes /dashboard in protected prefixes", () => {
    expect(PROTECTED_PREFIXES).toContain("/dashboard");
  });

  it("includes /admin in admin prefixes", () => {
    expect(ADMIN_PREFIXES).toContain("/admin");
  });

  it("includes /login and /register in auth pages", () => {
    expect(AUTH_PAGES).toContain("/login");
    expect(AUTH_PAGES).toContain("/register");
  });
});

describe("authorized callback — unauthenticated user", () => {
  it("allows access to the home page", () => {
    const result = authorized({ auth: null, request: makeRequest("/") });
    expect(result).toBe(true);
  });

  it("allows access to /login", () => {
    const result = authorized({ auth: null, request: makeRequest("/login") });
    expect(result).toBe(true);
  });

  it("allows access to /register", () => {
    const result = authorized({
      auth: null,
      request: makeRequest("/register"),
    });
    expect(result).toBe(true);
  });

  it("redirects /dashboard to /login", () => {
    const result = authorized({
      auth: null,
      request: makeRequest("/dashboard"),
    });
    expect(result).toBeInstanceOf(Response);
    const location = (result as Response).headers.get("location")!;
    expect(location).toContain("/login");
  });

  it("appends callbackUrl (relative path) when redirecting to /login", () => {
    const result = authorized({
      auth: null,
      request: makeRequest("/dashboard/settings"),
    });
    const location = (result as Response).headers.get("location")!;
    const redirectUrl = new URL(location, "http://localhost:3000");
    expect(redirectUrl.searchParams.get("callbackUrl")).toBe(
      "/dashboard/settings",
    );
  });

  it("redirects all PROTECTED_PREFIXES to /login", () => {
    for (const prefix of PROTECTED_PREFIXES) {
      const result = authorized({
        auth: null,
        request: makeRequest(`${prefix}/page`),
      });
      expect(result).toBeInstanceOf(Response);
      const location = (result as Response).headers.get("location")!;
      expect(location).toContain("/login");
    }
  });
});

describe("authorized callback — authenticated user", () => {
  it("allows access to protected routes", () => {
    const result = authorized({
      auth: makeSession(),
      request: makeRequest("/dashboard"),
    });
    expect(result).toBe(true);
  });

  it("allows access to nested protected routes", () => {
    const result = authorized({
      auth: makeSession(),
      request: makeRequest("/dashboard/posts/123"),
    });
    expect(result).toBe(true);
  });

  it("redirects /login to /dashboard", () => {
    const result = authorized({
      auth: makeSession(),
      request: makeRequest("/login"),
    });
    expect(result).toBeInstanceOf(Response);
    const location = (result as Response).headers.get("location")!;
    expect(location).toContain("/dashboard");
  });

  it("redirects /register to /dashboard", () => {
    const result = authorized({
      auth: makeSession(),
      request: makeRequest("/register"),
    });
    expect(result).toBeInstanceOf(Response);
    const location = (result as Response).headers.get("location")!;
    expect(location).toContain("/dashboard");
  });

  it("respects a safe callbackUrl on the login page", () => {
    const result = authorized({
      auth: makeSession(),
      request: makeRequest("/login?callbackUrl=%2Fdashboard%2Fposts"),
    });
    const location = (result as Response).headers.get("location")!;
    expect(location).toContain("/dashboard/posts");
  });

  it("ignores an absolute callbackUrl to prevent open-redirect", () => {
    const result = authorized({
      auth: makeSession(),
      request: makeRequest("/login?callbackUrl=https%3A%2F%2Fevil.com"),
    });
    const location = (result as Response).headers.get("location")!;
    expect(location).toContain("/dashboard");
    expect(location).not.toContain("evil.com");
  });

  it("allows access to the home page", () => {
    const result = authorized({
      auth: makeSession(),
      request: makeRequest("/"),
    });
    expect(result).toBe(true);
  });
});

describe("authorized callback — admin routes (unauthenticated)", () => {
  it("redirects /admin to /login when not authenticated", () => {
    const result = authorized({ auth: null, request: makeRequest("/admin") });
    expect(result).toBeInstanceOf(Response);
    const location = (result as Response).headers.get("location")!;
    expect(location).toContain("/login");
  });

  it("appends callbackUrl when redirecting unauthenticated user from /admin", () => {
    const result = authorized({
      auth: null,
      request: makeRequest("/admin/users"),
    });
    const location = (result as Response).headers.get("location")!;
    const redirectUrl = new URL(location, "http://localhost:3000");
    expect(redirectUrl.searchParams.get("callbackUrl")).toBe("/admin/users");
  });

  it("redirects all ADMIN_PREFIXES to /login when unauthenticated", () => {
    for (const prefix of ADMIN_PREFIXES) {
      const result = authorized({
        auth: null,
        request: makeRequest(`${prefix}/page`),
      });
      expect(result).toBeInstanceOf(Response);
      const location = (result as Response).headers.get("location")!;
      expect(location).toContain("/login");
    }
  });
});

describe("authorized callback — admin routes (USER role)", () => {
  it("redirects USER to /forbidden when accessing /admin", () => {
    const result = authorized({
      auth: makeSession("USER"),
      request: makeRequest("/admin"),
    });
    expect(result).toBeInstanceOf(Response);
    const location = (result as Response).headers.get("location")!;
    expect(location).toContain("/forbidden");
  });

  it("redirects USER to /forbidden for nested admin routes", () => {
    const result = authorized({
      auth: makeSession("USER"),
      request: makeRequest("/admin/users/42"),
    });
    expect(result).toBeInstanceOf(Response);
    const location = (result as Response).headers.get("location")!;
    expect(location).toContain("/forbidden");
  });
});

describe("authorized callback — admin routes (ADMIN role)", () => {
  it("allows ADMIN to access /admin", () => {
    const result = authorized({
      auth: makeSession("ADMIN"),
      request: makeRequest("/admin"),
    });
    expect(result).toBe(true);
  });

  it("allows ADMIN to access nested admin routes", () => {
    const result = authorized({
      auth: makeSession("ADMIN"),
      request: makeRequest("/admin/users"),
    });
    expect(result).toBe(true);
  });
});

describe("authorized callback — /forbidden page", () => {
  it("allows unauthenticated access to /forbidden", () => {
    const result = authorized({
      auth: null,
      request: makeRequest("/forbidden"),
    });
    expect(result).toBe(true);
  });

  it("allows authenticated USER access to /forbidden", () => {
    const result = authorized({
      auth: makeSession("USER"),
      request: makeRequest("/forbidden"),
    });
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The proxy handler itself: the rate limit, the session gate, experiment
// routing, and their order.
// ---------------------------------------------------------------------------

function request(
  path: string,
  init: {
    method?: string;
    address?: string;
    cookies?: Record<string, string>;
    country?: string;
  } = {},
): NextRequest {
  const headers = new Headers({
    "x-forwarded-for": init.address ?? "203.0.113.9",
  });
  if (init.country) headers.set("x-vercel-ip-country", init.country);

  const cookies = Object.entries(init.cookies ?? {});
  if (cookies.length > 0) {
    headers.set(
      "cookie",
      cookies.map(([name, value]) => `${name}=${value}`).join("; "),
    );
  }

  return new NextRequest(`https://example.test${path}`, {
    method: init.method ?? "GET",
    headers,
  });
}

const event = {} as NextFetchEvent;

const NOW = 1_800_000_000_000;

/** A fresh address per test, so the process-wide store cannot leak between them. */
let addressCounter = 0;
function freshAddress(): string {
  addressCounter += 1;
  return `198.51.${Math.floor(addressCounter / 250)}.${addressCounter % 250}`;
}

beforeEach(() => {
  sessionGate.mockClear();
  sessionGate.mockImplementation(() => undefined);
});

describe("the matcher", () => {
  it("covers NextAuth's endpoints", () => {
    // The regression this feature exists for. While `api/auth` was excluded
    // here, `POST /api/auth/callback/credentials` — one argon2 verification per
    // request, reachable directly with a CSRF token anyone can fetch — never
    // reached this file and could not be counted.
    expect(config.matcher.join(" ")).not.toContain("api/auth");
  });

  it("still skips Next's internals and static assets", () => {
    const matcher = config.matcher.join(" ");
    expect(matcher).toContain("_next/static");
    expect(matcher).toContain("_next/image");
    expect(matcher).toContain("favicon");
  });
});

describe("proxy", () => {
  it("runs the session gate for an ordinary page", async () => {
    await proxy(request("/dashboard", { address: freshAddress() }), event);
    expect(sessionGate).toHaveBeenCalledTimes(1);
  });

  it("substitutes next() when the gate returns nothing", async () => {
    const response = await proxy(
      request("/dashboard", { address: freshAddress() }),
      event,
    );
    expect(response.status).toBe(200);
  });

  it("passes the gate's own response through", async () => {
    const redirect = NextResponse.redirect("https://example.test/login");
    sessionGate.mockImplementation(() => redirect);

    const response = await proxy(
      request("/dashboard", { address: freshAddress() }),
      event,
    );
    expect(response.headers.get("location")).toBe("https://example.test/login");
  });

  it("does not run the session gate on NextAuth's own endpoints", async () => {
    // The exclusion that used to live in the matcher. It has to survive, or
    // every OAuth callback acquires a session read it never needed.
    await proxy(
      request("/api/auth/callback/google", { address: freshAddress() }),
      event,
    );
    expect(sessionGate).not.toHaveBeenCalled();
  });

  it("still counts those endpoints", async () => {
    const address = freshAddress();
    const attempt = () =>
      proxy(
        request("/api/auth/callback/credentials", { method: "POST", address }),
        event,
      );

    for (let index = 0; index < 10; index += 1) {
      expect((await attempt()).status).not.toBe(429);
    }

    expect((await attempt()).status).toBe(429);
  });

  it("refuses before the session gate runs", async () => {
    // The reason the limit is applied here at all: a refused request must not
    // cost a session read, a route match, or a database connection.
    const address = freshAddress();

    for (let index = 0; index < 10; index += 1) {
      await proxy(request("/login", { method: "POST", address }), event);
    }
    sessionGate.mockClear();

    const refused = await proxy(
      request("/login", { method: "POST", address }),
      event,
    );

    expect(refused.status).toBe(429);
    expect(sessionGate).not.toHaveBeenCalled();
  });

  it("reports the remaining budget on an allowed request", async () => {
    const response = await proxy(
      request("/login", { method: "POST", address: freshAddress() }),
      event,
    );

    expect(response.headers.get("RateLimit-Limit")).toBe("10");
    expect(response.headers.get("RateLimit-Remaining")).toBe("9");
  });

  it("leaves unlimited traffic without rate-limit headers", async () => {
    const response = await proxy(
      request("/blog", { address: freshAddress() }),
      event,
    );
    expect(response.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("uses one clock reading for the decision and the headers", async () => {
    // Three reads of Date.now() produce three instants, and a Retry-After
    // computed from a later one than the decision is a Retry-After that is
    // subtly too short.
    const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      await proxy(
        request("/login", { method: "POST", address: freshAddress() }),
        event,
      );
      expect(now).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Experiment routing: the third concern, and its position relative to the
// other two. The mechanics live in `@/lib/experiments/*` and are tested there;
// what is asserted here is the composition.
// ---------------------------------------------------------------------------

describe("proxy — experiment routing", () => {
  const VISITOR = "0189d0aa-4b27-4d1f-9c3e-2f7f8a1b2c3d";

  it("mints both cookies on a first visit to an experiment path", async () => {
    const cookies = (
      await proxy(
        request("/pricing", { address: freshAddress(), country: "US" }),
        event,
      )
    ).headers.getSetCookie();

    expect(cookies.some((c) => c.startsWith(`${VISITOR_COOKIE}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${ASSIGNMENT_COOKIE}=`))).toBe(
      true,
    );
    // https in these tests, so the cookies must carry Secure.
    expect(cookies.every((c) => c.includes("Secure"))).toBe(true);
    expect(cookies.every((c) => c.includes("HttpOnly"))).toBe(true);
  });

  it("rewrites to the assigned arm without changing the URL", async () => {
    const response = await proxy(
      request("/pricing", {
        address: freshAddress(),
        country: "US",
        cookies: {
          [VISITOR_COOKIE]: VISITOR,
          [ASSIGNMENT_COOKIE]: "pricing-cta:annual-first",
        },
      }),
      event,
    );

    expect(response.headers.get("x-middleware-rewrite")).toContain(
      "/pricing/v/annual-first",
    );
    // A rewrite, not a redirect: the arm must not reach the address bar.
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("serves the canonical page for the control arm", async () => {
    const response = await proxy(
      request("/pricing", {
        address: freshAddress(),
        country: "US",
        cookies: {
          [VISITOR_COOKIE]: VISITOR,
          [ASSIGNMENT_COOKIE]: "pricing-cta:control",
        },
      }),
      event,
    );
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("reports the exposure on the canonical path", async () => {
    const response = await proxy(
      request("/pricing", { address: freshAddress(), country: "US" }),
      event,
    );
    expect(response.headers.get("x-experiment-exposure")).toMatch(
      /^pricing-cta:(control|annual-first)$/u,
    );
  });

  it("leaves other pages untouched", async () => {
    const response = await proxy(
      request("/blog", { address: freshAddress(), country: "US" }),
      event,
    );
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(response.headers.get("x-experiment-exposure")).toBeNull();
  });

  it("does not put cookies on a route handler's response", async () => {
    // No browser to keep them in: a polled endpoint would mint a new visitor
    // per call and carry Set-Cookie on responses meant to be cacheable.
    const response = await proxy(
      request("/api/health", { address: freshAddress() }),
      event,
    );
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("does not bucket a request the rate limiter refused", async () => {
    // Ordering: the limit is still first. A refusal must cost nothing beyond
    // the counter — no cookie minted, no assignment computed.
    // A POST to a page path is a Server Action as far as the limiter is
    // concerned, which is the 120/minute budget.
    const address = freshAddress();
    for (let index = 0; index < 120; index += 1) {
      await proxy(request("/pricing", { method: "POST", address }), event);
    }

    const refused = await proxy(
      request("/pricing", { method: "POST", address }),
      event,
    );

    expect(refused.status).toBe(429);
    expect(refused.headers.getSetCookie()).toEqual([]);
  });

  it("keeps the cookies on a response the session gate refused", async () => {
    // Otherwise everyone who signs in comes back as a brand new visitor and is
    // bucketed afresh on the other side of the login.
    const redirect = NextResponse.redirect("https://example.test/login");
    sessionGate.mockImplementation(() => redirect);

    const response = await proxy(
      request("/pricing", { address: freshAddress(), country: "US" }),
      event,
    );

    expect(response.headers.get("location")).toBe("https://example.test/login");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(response.headers.getSetCookie().length).toBe(2);
  });

  it("still reports the rate-limit budget on a bucketed response", async () => {
    // The rewrite rebuilds the response, so the headers the limiter adds have
    // to be applied to the one that is actually returned.
    const response = await proxy(
      request("/pricing", {
        method: "POST",
        address: freshAddress(),
        country: "US",
      }),
      event,
    );
    expect(response.headers.get("RateLimit-Limit")).toBe("120");
    expect(response.headers.get("RateLimit-Remaining")).toBe("119");
  });
});
