import { describe, expect, it } from "vitest";
import {
  API_READ_POLICY,
  API_WRITE_POLICY,
  AUTHENTICATION_POLICY,
  AUTH_ENDPOINT_POLICY,
  RATE_LIMIT_EXEMPT,
  RATE_LIMIT_RULES,
  SERVER_ACTION_POLICY,
  isApiPath,
  isExempt,
  selectPolicy,
} from "@/lib/rate-limit/policy";
import type { RequestDescriptor } from "@/lib/rate-limit/policy";

function describeRequest(
  overrides: Partial<RequestDescriptor> = {},
): RequestDescriptor {
  return {
    method: "GET",
    pathname: "/",
    isServerAction: false,
    ...overrides,
  };
}

describe("isApiPath", () => {
  it("matches the API surface and nothing that merely starts like it", () => {
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api/posts")).toBe(true);
    expect(isApiPath("/apidocs")).toBe(false);
    expect(isApiPath("/posts/api")).toBe(false);
  });
});

describe("selectPolicy", () => {
  it("does not limit a page navigation", () => {
    // Next prefetches every `<Link>` that scrolls into view, so a budget here
    // would refuse the framework's own traffic. Nothing is read or written.
    expect(
      selectPolicy(describeRequest({ pathname: "/posts" })),
    ).toBeUndefined();
    expect(
      selectPolicy(describeRequest({ pathname: "/blog/hello" })),
    ).toBeUndefined();
  });

  it("puts both doors to the password check on one budget", () => {
    // NextAuth's own credentials endpoint...
    const direct = selectPolicy(
      describeRequest({
        method: "POST",
        pathname: "/api/auth/callback/credentials",
      }),
    );
    // ...and the Server Action that reaches the same check through `signIn`.
    const action = selectPolicy(
      describeRequest({
        method: "POST",
        pathname: "/login",
        isServerAction: true,
      }),
    );

    expect(direct?.policy).toBe(AUTHENTICATION_POLICY);
    expect(action?.policy).toBe(AUTHENTICATION_POLICY);
    // Same bucket, so alternating between them does not buy twice the attempts.
    expect(direct?.scope).toBe(action?.scope);
  });

  it("counts registration against the credential budget too", () => {
    expect(
      selectPolicy(
        describeRequest({
          method: "POST",
          pathname: "/register",
          isServerAction: true,
        }),
      )?.policy,
    ).toBe(AUTHENTICATION_POLICY);
  });

  it("leaves the rest of the auth surface usable", () => {
    // `/api/auth/session` is polled by the client on window focus and the OAuth
    // redirects land here; refusing them breaks sign-in for a real user.
    for (const pathname of [
      "/api/auth/session",
      "/api/auth/csrf",
      "/api/auth/providers",
    ]) {
      expect(selectPolicy(describeRequest({ pathname }))?.policy).toBe(
        AUTH_ENDPOINT_POLICY,
      );
    }
  });

  it("treats the OAuth callback as an ordinary auth endpoint", () => {
    // It is a GET carrying a provider code, not a password guess.
    expect(
      selectPolicy(describeRequest({ pathname: "/api/auth/callback/google" }))
        ?.policy,
    ).toBe(AUTH_ENDPOINT_POLICY);
  });

  it("separates API reads from API writes", () => {
    expect(
      selectPolicy(describeRequest({ pathname: "/api/posts" }))?.policy,
    ).toBe(API_READ_POLICY);
    expect(
      selectPolicy(
        describeRequest({ method: "POST", pathname: "/api/revalidate" }),
      )?.policy,
    ).toBe(API_WRITE_POLICY);
    expect(
      selectPolicy(
        describeRequest({ method: "DELETE", pathname: "/api/posts" }),
      )?.policy,
    ).toBe(API_WRITE_POLICY);
  });

  it("gives each API endpoint its own bucket", () => {
    // Sharing one counter across endpoints would make a limit depend on which
    // pages the user happened to visit.
    const posts = selectPolicy(describeRequest({ pathname: "/api/posts" }));
    const photos = selectPolicy(describeRequest({ pathname: "/api/photos" }));

    expect(posts?.policy).toBe(photos?.policy);
    expect(posts?.scope).not.toBe(photos?.scope);
  });

  it("puts every other Server Action on one budget", () => {
    const selected = selectPolicy(
      describeRequest({
        method: "POST",
        pathname: "/posts/abc",
        isServerAction: true,
      }),
    );

    expect(selected?.policy).toBe(SERVER_ACTION_POLICY);
    expect(selected?.scope).toBe(SERVER_ACTION_POLICY.name);
  });

  it("prefers the API rules to the Server Action fallback", () => {
    // A POST to /api is not a Server Action, and `isServerAction` is false for
    // it — but the ordering is what makes that survive a future change to the
    // detection heuristic.
    const selected = selectPolicy(
      describeRequest({
        method: "POST",
        pathname: "/api/posts",
        isServerAction: true,
      }),
    );
    expect(selected?.policy).toBe(API_WRITE_POLICY);
  });

  it("exempts what is written down as exempt, and only that", () => {
    expect(
      selectPolicy(describeRequest({ pathname: "/api/health" })),
    ).toBeUndefined();
    expect(isExempt("/api/health")).toBe(true);
    expect(isExempt("/api/posts")).toBe(false);
  });
});

describe("the table itself", () => {
  it("gives every policy a reason", () => {
    for (const rule of RATE_LIMIT_RULES) {
      expect(rule.policy.because.length).toBeGreaterThan(20);
      expect(rule.policy.limit).toBeGreaterThan(0);
      expect(rule.policy.windowMs).toBeGreaterThan(0);
    }
    for (const entry of RATE_LIMIT_EXEMPT) {
      expect(entry.because.length).toBeGreaterThan(20);
    }
  });

  it("holds the credential budget below the others", () => {
    // If this stops being true, a password guess is cheaper than a page write,
    // which is the wrong way round.
    for (const policy of [
      SERVER_ACTION_POLICY,
      API_WRITE_POLICY,
      API_READ_POLICY,
      AUTH_ENDPOINT_POLICY,
    ]) {
      expect(AUTHENTICATION_POLICY.limit).toBeLessThan(policy.limit);
    }
  });
});
