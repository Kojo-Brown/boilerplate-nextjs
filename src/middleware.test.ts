import { describe, it, expect } from "vitest";
import { authConfig, PROTECTED_PREFIXES, AUTH_PAGES } from "@/auth.config";

type AuthorizedParams = Parameters<
  NonNullable<NonNullable<typeof authConfig.callbacks>["authorized"]>
>[0];

function makeRequest(path: string, origin = "http://localhost:3000") {
  const url = new URL(path, origin);
  return { nextUrl: url } as AuthorizedParams["request"];
}

function makeSession(role: "USER" | "ADMIN" = "USER"): AuthorizedParams["auth"] {
  return {
    user: { id: "user-1", email: "user@example.com", name: "Test User", role },
    expires: new Date(Date.now() + 3600 * 1000).toISOString(),
  };
}

const authorized = authConfig.callbacks!.authorized!;

describe("PROTECTED_PREFIXES / AUTH_PAGES constants", () => {
  it("includes /dashboard in protected prefixes", () => {
    expect(PROTECTED_PREFIXES).toContain("/dashboard");
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
    const result = authorized({ auth: null, request: makeRequest("/register") });
    expect(result).toBe(true);
  });

  it("redirects /dashboard to /login", () => {
    const result = authorized({ auth: null, request: makeRequest("/dashboard") });
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
    expect(redirectUrl.searchParams.get("callbackUrl")).toBe("/dashboard/settings");
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
