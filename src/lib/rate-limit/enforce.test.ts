import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import {
  TOO_MANY_REQUESTS_MESSAGE,
  applyRateLimitHeaders,
  describeRequest,
  enforceRateLimit,
  isServerActionRequest,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit/enforce";
import { AUTHENTICATION_POLICY } from "@/lib/rate-limit/policy";
import { MemoryRateLimitStore } from "@/lib/rate-limit/store";
import type { RateLimitOutcome } from "@/lib/rate-limit/enforce";

const NOW = 1_800_000_000_000;

function request(
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(`https://example.test${path}`, {
    method: init.method ?? "GET",
    ...(init.headers ? { headers: init.headers } : {}),
  });
}

/** A request from a client the identity resolver can actually name. */
function fromClient(
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
  address = "203.0.113.9",
): NextRequest {
  return request(path, {
    ...init,
    headers: { "x-forwarded-for": address, ...init.headers },
  });
}

describe("isServerActionRequest", () => {
  it("recognises the header Next sends when JavaScript is running", () => {
    expect(
      isServerActionRequest(
        request("/posts", {
          method: "POST",
          headers: { "next-action": "abc123" },
        }),
      ),
    ).toBe(true);
  });

  it("recognises a POST to a page with no header at all", () => {
    // The bypass a header-only check has: the progressive-enhancement form post
    // does not carry `Next-Action`, and neither does curl. In an App Router
    // application there is no other way to POST to a page path.
    expect(isServerActionRequest(request("/login", { method: "POST" }))).toBe(
      true,
    );
  });

  it("does not mistake a route handler for one", () => {
    expect(
      isServerActionRequest(request("/api/posts", { method: "POST" })),
    ).toBe(false);
  });

  it("is false for everything that is not a POST", () => {
    for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
      expect(isServerActionRequest(request("/posts", { method }))).toBe(false);
    }
  });
});

describe("describeRequest", () => {
  it("reduces a request to what the rules look at", () => {
    expect(
      describeRequest(
        request("/posts?draft=1", {
          method: "POST",
          headers: { "next-action": "abc" },
        }),
      ),
    ).toEqual({ method: "POST", pathname: "/posts", isServerAction: true });
  });
});

describe("enforceRateLimit", () => {
  it("skips the store entirely for traffic no rule matches", async () => {
    const store = new MemoryRateLimitStore();

    expect(
      await enforceRateLimit(fromClient("/posts"), { store, now: NOW }),
    ).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("refuses the eleventh credential attempt in a minute", async () => {
    const store = new MemoryRateLimitStore();
    const attempt = (offset: number) =>
      enforceRateLimit(fromClient("/login", { method: "POST" }), {
        store,
        now: NOW + offset,
      });

    for (let index = 0; index < AUTHENTICATION_POLICY.limit; index += 1) {
      expect((await attempt(index))?.decision.allowed).toBe(true);
    }

    const refused = await attempt(AUTHENTICATION_POLICY.limit);
    expect(refused?.decision.allowed).toBe(false);
    expect(refused?.policy).toBe(AUTHENTICATION_POLICY);
  });

  it("counts NextAuth's own credentials endpoint against the same budget", async () => {
    // The hole this feature closes: `/api/auth/callback/credentials` is
    // reachable directly, every request to it is one argon2 verification, and
    // it sat outside the proxy's matcher entirely.
    const store = new MemoryRateLimitStore();

    for (let index = 0; index < AUTHENTICATION_POLICY.limit; index += 1) {
      await enforceRateLimit(fromClient("/login", { method: "POST" }), {
        store,
        now: NOW + index,
      });
    }

    const direct = await enforceRateLimit(
      fromClient("/api/auth/callback/credentials", { method: "POST" }),
      { store, now: NOW + 20 },
    );
    expect(direct?.decision.allowed).toBe(false);
  });

  it("keeps different clients apart", async () => {
    const store = new MemoryRateLimitStore();

    for (let index = 0; index < AUTHENTICATION_POLICY.limit; index += 1) {
      await enforceRateLimit(
        fromClient("/login", { method: "POST" }, "203.0.113.9"),
        { store, now: NOW + index },
      );
    }

    const other = await enforceRateLimit(
      fromClient("/login", { method: "POST" }, "198.51.100.7"),
      { store, now: NOW + 20 },
    );
    expect(other?.decision.allowed).toBe(true);
  });

  it("cannot be reset by rewriting the left of x-forwarded-for", async () => {
    const store = new MemoryRateLimitStore();

    // Ten attempts, each claiming to come from somewhere new. Our proxy
    // appended the real address on the right of every one of them.
    for (let index = 0; index < AUTHENTICATION_POLICY.limit; index += 1) {
      await enforceRateLimit(
        request("/login", {
          method: "POST",
          headers: { "x-forwarded-for": `10.0.0.${index}, 203.0.113.9` },
        }),
        { store, now: NOW + index, trustedProxies: 1 },
      );
    }

    const eleventh = await enforceRateLimit(
      request("/login", {
        method: "POST",
        headers: { "x-forwarded-for": "10.0.0.99, 203.0.113.9" },
      }),
      { store, now: NOW + 20, trustedProxies: 1 },
    );
    expect(eleventh?.decision.allowed).toBe(false);
  });

  it("cannot be reset by rotating IPv6 hosts inside one /64", async () => {
    const store = new MemoryRateLimitStore();

    for (let index = 0; index < AUTHENTICATION_POLICY.limit; index += 1) {
      await enforceRateLimit(
        fromClient(
          "/login",
          { method: "POST" },
          `2001:db8:85a3:1234::${index + 1}`,
        ),
        { store, now: NOW + index },
      );
    }

    const eleventh = await enforceRateLimit(
      fromClient("/login", { method: "POST" }, "2001:db8:85a3:1234::dead"),
      { store, now: NOW + 20 },
    );
    expect(eleventh?.decision.allowed).toBe(false);
  });

  it("readmits a client that waits exactly as long as it was told", async () => {
    // The regression, at the level it was found: against a running server, a
    // caller who spent the credential budget and slept for the `Retry-After` it
    // was handed got a second 429, because the header was the end of the window
    // and the previous window still overlapped almost entirely one millisecond
    // past it.
    const store = new MemoryRateLimitStore();
    const attempt = (at: number) =>
      enforceRateLimit(fromClient("/login", { method: "POST" }), {
        store,
        now: at,
      });

    for (let index = 0; index < AUTHENTICATION_POLICY.limit; index += 1) {
      await attempt(NOW + index);
    }

    const refused = await attempt(NOW + 20);
    expect(refused?.decision.allowed).toBe(false);

    const retryAt = refused?.decision.retryAt ?? 0;
    expect(retryAt).toBeGreaterThan(NOW + AUTHENTICATION_POLICY.windowMs);
    expect((await attempt(retryAt))?.decision.allowed).toBe(true);
  });

  it("does not limit the liveness probe", async () => {
    const store = new MemoryRateLimitStore();

    for (let index = 0; index < 1_000; index += 1) {
      expect(
        await enforceRateLimit(fromClient("/api/health"), {
          store,
          now: NOW + index,
        }),
      ).toBeUndefined();
    }
  });
});

describe("rateLimitHeaders", () => {
  const outcome: RateLimitOutcome = {
    policy: AUTHENTICATION_POLICY,
    key: "authentication|203.0.113.9",
    decision: {
      allowed: true,
      limit: 10,
      remaining: 7,
      resetAt: NOW + 42_400,
      retryAt: NOW,
      window: { start: NOW, current: 3, previous: 0 },
    },
  };

  it("reports the budget in the IETF fields", () => {
    expect(rateLimitHeaders(outcome, NOW)).toEqual({
      "RateLimit-Limit": "10",
      "RateLimit-Remaining": "7",
      "RateLimit-Reset": "43",
      "RateLimit-Policy": "10;w=60",
    });
  });

  it("never reports a negative reset", () => {
    const stale = {
      ...outcome,
      decision: { ...outcome.decision, resetAt: NOW - 5_000 },
    };
    expect(rateLimitHeaders(stale, NOW)["RateLimit-Reset"]).toBe("0");
  });
});

describe("tooManyRequests", () => {
  const refused: RateLimitOutcome = {
    policy: AUTHENTICATION_POLICY,
    key: "authentication|203.0.113.9",
    decision: {
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: NOW + 60_000,
      retryAt: NOW + 6_000,
      window: { start: NOW, current: 10, previous: 0 },
    },
  };

  it("answers a route handler in the envelope every other failure uses", async () => {
    const response = tooManyRequests(fromClient("/api/posts"), refused, NOW);

    expect(response.status).toBe(429);
    expect(response.headers.get("RateLimit-Remaining")).toBe("0");
    // Two different numbers, deliberately: `Retry-After` is when one more would
    // get through, `RateLimit-Reset` when the whole budget is back. Reporting
    // the second as the first is how a client that obeys the header is refused
    // a second time.
    expect(response.headers.get("Retry-After")).toBe("6");
    expect(response.headers.get("RateLimit-Reset")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: { code: "too_many_requests", message: TOO_MANY_REQUESTS_MESSAGE },
    });
  });

  it("answers everything else in plain text", async () => {
    const response = tooManyRequests(fromClient("/login"), refused, NOW);

    expect(response.status).toBe(429);
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    await expect(response.text()).resolves.toContain(TOO_MANY_REQUESTS_MESSAGE);
  });

  it("never tells a client to retry immediately", async () => {
    // A `Retry-After: 0` is an instruction to try again now, which is the
    // opposite of what a 429 means.
    const imminent = {
      ...refused,
      decision: { ...refused.decision, retryAt: NOW + 1 },
    };
    expect(
      tooManyRequests(fromClient("/api/posts"), imminent, NOW).headers.get(
        "Retry-After",
      ),
    ).toBe("1");
  });
});

describe("applyRateLimitHeaders", () => {
  it("adds the budget to a response that was allowed through", () => {
    const outcome: RateLimitOutcome = {
      policy: AUTHENTICATION_POLICY,
      key: "authentication|203.0.113.9",
      decision: {
        allowed: true,
        limit: 10,
        remaining: 9,
        resetAt: NOW + 60_000,
        retryAt: NOW,
        window: { start: NOW, current: 1, previous: 0 },
      },
    };

    const response = applyRateLimitHeaders(NextResponse.next(), outcome, NOW);
    expect(response.headers.get("RateLimit-Remaining")).toBe("9");
  });

  it("leaves an unlimited response untouched", () => {
    const response = NextResponse.next();
    expect(applyRateLimitHeaders(response, undefined, NOW)).toBe(response);
    expect(response.headers.get("RateLimit-Limit")).toBeNull();
  });
});
