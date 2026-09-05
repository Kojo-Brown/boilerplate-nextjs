import { describe, expect, it } from "vitest";
import {
  PROXY_FUNCTION_KEY,
  builtRoutes,
  checkRateLimitCoverage,
  isMatched,
  readProxyConfig,
  sampleUrl,
} from "./assert-rate-limit-coverage";
import type { ProxyConfig } from "./assert-rate-limit-coverage";

/** The matcher this repository ships, as Next compiles it. */
const CURRENT_MATCHER =
  "^(?:\\/(_next\\/data\\/[^/]{1,}))?(?:\\/((?!_next\\/static|_next\\/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*))(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$";

/** The matcher it shipped before this feature, which excluded `api/auth`. */
const MATCHER_EXCLUDING_AUTH =
  "^(?:\\/(_next\\/data\\/[^/]{1,}))?(?:\\/((?!api\\/auth|_next\\/static|_next\\/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*))(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$";

const proxyWith = (regexp: string): ProxyConfig => ({
  runtime: "nodejs",
  matchers: [new RegExp(regexp, "u")],
});

const APP_PATHS = {
  "/api/health/route": "/api/health",
  "/api/posts/route": "/api/posts",
  "/api/auth/[...nextauth]/route": "/api/auth/[...nextauth]",
  "/page": "/",
  "/login/page": "/login",
  "/posts/[id]/page": "/posts/[id]",
};

describe("readProxyConfig", () => {
  it("reads the compiled matchers and the runtime", () => {
    const config = readProxyConfig({
      functions: {
        [PROXY_FUNCTION_KEY]: {
          runtime: "nodejs",
          matchers: [{ regexp: CURRENT_MATCHER }],
        },
      },
    });

    expect(config.runtime).toBe("nodejs");
    expect(config.matchers).toHaveLength(1);
  });

  it("refuses to treat a missing proxy as a passing build", () => {
    // "No proxy" and "a proxy that matches everything" look the same to a check
    // that reads absence as a value, and only one of them is safe.
    expect(() => readProxyConfig({ functions: {} })).toThrow(
      /absent from the functions config manifest/u,
    );
  });

  it("refuses a proxy with no matchers", () => {
    expect(() =>
      readProxyConfig({
        functions: { [PROXY_FUNCTION_KEY]: { matchers: [] } },
      }),
    ).toThrow(/declares no matchers/u);
  });
});

describe("sampleUrl", () => {
  it("turns a route pattern into a path a request could carry", () => {
    expect(sampleUrl("/api/posts")).toBe("/api/posts");
    expect(sampleUrl("/posts/[id]")).toBe("/posts/sample");
    expect(sampleUrl("/api/auth/[...nextauth]")).toBe(
      "/api/auth/sample/segments",
    );
    expect(sampleUrl("/shop/[[...slug]]")).toBe("/shop/sample/segments");
  });
});

describe("isMatched", () => {
  it("agrees with the matcher on what the proxy sees", () => {
    const matchers = [new RegExp(CURRENT_MATCHER, "u")];

    expect(isMatched("/login", matchers)).toBe(true);
    expect(isMatched("/api/posts", matchers)).toBe(true);
    expect(isMatched("/api/auth/callback/credentials", matchers)).toBe(true);
    expect(isMatched("/_next/static/chunk.js", matchers)).toBe(false);
    expect(isMatched("/logo.svg", matchers)).toBe(false);
  });
});

describe("builtRoutes", () => {
  it("separates route handlers from pages", () => {
    expect(builtRoutes(APP_PATHS)).toEqual({
      routeHandlers: ["/api/auth/[...nextauth]", "/api/health", "/api/posts"],
      pages: ["/", "/login", "/posts/[id]"],
    });
  });
});

describe("checkRateLimitCoverage", () => {
  it("passes on the matcher this repository ships", () => {
    expect(
      checkRateLimitCoverage(APP_PATHS, proxyWith(CURRENT_MATCHER)),
    ).toEqual([]);
  });

  it("catches the endpoint the old matcher excluded", () => {
    // The regression this gate exists for, reproduced against the matcher that
    // was in place before this feature: `POST /api/auth/callback/credentials`
    // is a password check, and nothing counted it.
    const violations = checkRateLimitCoverage(
      APP_PATHS,
      proxyWith(MATCHER_EXCLUDING_AUTH),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.route).toBe("/api/auth/[...nextauth]");
    expect(violations[0]?.problem).toContain("not matched by the proxy");
  });

  it("accepts a new endpoint the API rules already cover", () => {
    expect(
      checkRateLimitCoverage(
        { ...APP_PATHS, "/api/webhooks/stripe/route": "/api/webhooks/stripe" },
        proxyWith(CURRENT_MATCHER),
      ),
    ).toEqual([]);
  });

  it("catches a route handler outside every rule", () => {
    const violations = checkRateLimitCoverage(
      { ...APP_PATHS, "/webhook/route": "/webhook" },
      proxyWith(CURRENT_MATCHER),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.route).toBe("/webhook");
    expect(violations[0]?.problem).toContain("matches no rule");
  });

  it("accepts an endpoint that is exempt by declaration", () => {
    // `/api/health` selects no policy on purpose; the exempt list is what makes
    // that a decision rather than an omission.
    const violations = checkRateLimitCoverage(
      { "/api/health/route": "/api/health" },
      proxyWith(CURRENT_MATCHER),
    );
    expect(violations).toEqual([]);
  });

  it("requires the matcher to cover pages, not only route handlers", () => {
    const excludeLogin = "^(?:\\/((?!login).*))(\\.json|\\.rsc)?[\\/#\\?]?$";
    const violations = checkRateLimitCoverage(
      { "/login/page": "/login" },
      proxyWith(excludeLogin),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("can host a Server Action");
  });
});
