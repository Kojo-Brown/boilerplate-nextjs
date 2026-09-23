import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Every case here re-imports the module.
 *
 * `AUTH_ORIGIN`, `USE_SECURE_COOKIES` and `SESSION_COOKIE_NAME` are resolved
 * once at module load, deliberately — Auth.js reads `process.env` on every
 * request, and a cookie *name* that could change between two requests would
 * change the salt the JWT is encrypted under, which would stop every
 * outstanding session decoding. Testing that requires loading the module under
 * a chosen environment rather than calling a function.
 */
async function loadUnder(environment: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) vi.stubEnv(key, undefined as unknown as string);
    else vi.stubEnv(key, value);
  }
  return import("@/lib/auth/deployment");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("AUTH_ORIGIN", () => {
  it("is the configured URL's origin", async () => {
    const deployment = await loadUnder({
      AUTH_URL: undefined,
      NEXTAUTH_URL: "https://app.example.com",
    });
    expect(deployment.AUTH_ORIGIN).toBe("https://app.example.com");
  });

  it("drops a path, so the action URL is not doubled up", async () => {
    // `createActionURL` appends `basePath` and the action to whatever it gets.
    // A configured value ending in a slash or carrying a path would otherwise
    // produce `/app/api/auth/session`.
    const deployment = await loadUnder({
      AUTH_URL: undefined,
      NEXTAUTH_URL: "https://app.example.com/some/path",
    });
    expect(deployment.AUTH_ORIGIN).toBe("https://app.example.com");
  });

  it("prefers an AUTH_URL the operator set themselves", async () => {
    const deployment = await loadUnder({
      AUTH_URL: "https://real.example.com",
      NEXTAUTH_URL: "https://stale.example.com",
    });
    expect(deployment.AUTH_ORIGIN).toBe("https://real.example.com");
    expect(process.env["AUTH_URL"]).toBe("https://real.example.com");
  });

  it("writes AUTH_URL when it is unset, because Auth.js only reads process.env", async () => {
    // The whole reason this module has a side effect. `createActionURL` and
    // `setEnvDefaults` read `process.env.AUTH_URL` directly; there is no
    // configuration field that reaches them. Without this copy, Auth.js falls
    // back to `x-forwarded-host`/`x-forwarded-proto` — headers a caller sends —
    // while `src/lib/env.ts` reports a perfectly good validated URL.
    const deployment = await loadUnder({
      AUTH_URL: undefined,
      NEXTAUTH_URL: "https://app.example.com",
    });
    expect(process.env["AUTH_URL"]).toBe(deployment.AUTH_ORIGIN);
  });
});

describe("cookie flags follow the pinned scheme", () => {
  it("uses Secure and the __Host- prefix on https", async () => {
    const deployment = await loadUnder({
      AUTH_URL: undefined,
      NEXTAUTH_URL: "https://app.example.com",
    });

    expect(deployment.USE_SECURE_COOKIES).toBe(true);
    expect(deployment.SESSION_COOKIE_NAME).toBe("__Host-authjs.session-token");
  });

  it("uses neither on http, or a browser would discard the cookie", async () => {
    // Not a weakening to be gated away: `Secure` on a plain-HTTP origin means
    // the browser drops every cookie and nobody can sign in at all. The name
    // has to lose the prefix with it, since `__Host-` requires `Secure`.
    const deployment = await loadUnder({
      AUTH_URL: undefined,
      NEXTAUTH_URL: "http://localhost:3000",
    });

    expect(deployment.USE_SECURE_COOKIES).toBe(false);
    expect(deployment.SESSION_COOKIE_NAME).toBe("authjs.session-token");
  });

  it("is decided by the pinned origin and not by NODE_ENV", async () => {
    // A production build served over plain HTTP for a local integration run
    // must still be able to hold a session. The browser's question is about the
    // scheme, not about how the bundle was compiled.
    const deployment = await loadUnder({
      AUTH_URL: undefined,
      NEXTAUTH_URL: "http://localhost:3000",
      NODE_ENV: "production",
    });

    expect(deployment.USE_SECURE_COOKIES).toBe(false);
  });

  it("never carries a Domain, which __Host- forbids", async () => {
    // Asserted against the name rather than the options because the prefix is
    // the part a browser enforces: a `__Host-` cookie sent with a `Domain` is
    // rejected before it is stored.
    const deployment = await loadUnder({
      AUTH_URL: undefined,
      NEXTAUTH_URL: "https://app.example.com",
    });
    const { authConfig } = await import("@/auth.config");

    expect(deployment.SESSION_COOKIE_NAME.startsWith("__Host-")).toBe(true);
    expect(authConfig.cookies.sessionToken.options).not.toHaveProperty(
      "domain",
    );
  });
});

describe("the config Auth.js is handed", () => {
  it("pins every session cookie flag", async () => {
    await loadUnder({
      AUTH_URL: undefined,
      NEXTAUTH_URL: "https://app.example.com",
    });
    const { authConfig } = await import("@/auth.config");

    expect(authConfig.cookies.sessionToken.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: true,
    });
  });

  it("trusts the host, which is only safe because the origin is pinned", async () => {
    await loadUnder({
      AUTH_URL: undefined,
      NEXTAUTH_URL: "https://app.example.com",
    });
    const { authConfig } = await import("@/auth.config");

    expect(authConfig.trustHost).toBe(true);
    expect(process.env["AUTH_URL"]).toBe("https://app.example.com");
  });

  it("shortens the idle window from Auth.js's 30-day default", async () => {
    await loadUnder({
      AUTH_URL: undefined,
      NEXTAUTH_URL: "https://app.example.com",
    });
    const { authConfig } = await import("@/auth.config");
    const { SESSION_IDLE_MAX_AGE_S } = await import("@/lib/auth/policy");

    expect(authConfig.session.maxAge).toBe(SESSION_IDLE_MAX_AGE_S);
    expect(authConfig.session.maxAge).toBeLessThan(60 * 60 * 24 * 30);
  });
});
