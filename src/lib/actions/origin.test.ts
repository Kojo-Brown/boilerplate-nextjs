import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ORIGIN_REJECTED_MESSAGE,
  assertSameOrigin,
  checkOrigin,
  parseAllowedOrigins,
} from "@/lib/actions/origin";
import { ActionError } from "@/lib/actions/result";
import { setRequestHeaders } from "@/test/request-headers";
import { env } from "@/lib/env";

/**
 * The origin leg, as a decision table.
 *
 * `checkOrigin` is pure so that the table can be written out rather than
 * simulated: every row below is a header combination a real deployment or a
 * real attacker produces, and the rule that decides it is one `if`.
 */
describe("checkOrigin", () => {
  const base = { allowedHosts: [] as string[] };

  it("accepts an Origin matching the Host", () => {
    expect(
      checkOrigin({
        ...base,
        origin: "https://app.example.com",
        host: "app.example.com",
        forwardedHost: null,
      }),
    ).toEqual({ allowed: true, host: "app.example.com" });
  });

  it("rejects an Origin naming another host", () => {
    const result = checkOrigin({
      ...base,
      origin: "https://evil.example",
      host: "app.example.com",
      forwardedHost: null,
    });

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(
      /does not match "app.example.com"/,
    );
  });

  it("rejects a request with no Origin header", () => {
    // The whole reason this module exists. Next logs a warning here and lets
    // the action run; see the note at the top of `origin.ts`.
    const result = checkOrigin({
      ...base,
      origin: null,
      host: "app.example.com",
      forwardedHost: null,
    });

    expect(result).toEqual({ allowed: false, reason: "no Origin header" });
  });

  it("rejects the opaque `null` origin", () => {
    // A sandboxed iframe or a `data:` document. It names no host, so it can
    // never legitimately match one.
    const result = checkOrigin({
      ...base,
      origin: "null",
      host: "app.example.com",
      forwardedHost: null,
    });

    expect(result).toEqual({ allowed: false, reason: "opaque (null) Origin" });
  });

  it("rejects an unparseable Origin", () => {
    const result = checkOrigin({
      ...base,
      origin: "not a url",
      host: "app.example.com",
      forwardedHost: null,
    });

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(/unparseable/);
  });

  it("rejects an Origin whose URL has no host", () => {
    // `new URL("file:///x")` parses and yields an empty host. An empty string
    // must not be able to match an empty or missing `Host`.
    const result = checkOrigin({
      ...base,
      origin: "file:///etc/passwd",
      host: "",
      forwardedHost: null,
    });

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(/names no host/);
  });

  it("prefers X-Forwarded-Host over Host, as Next's own check does", () => {
    // Behind a proxy, `host` is the internal name and would never match the
    // public origin the browser sent.
    expect(
      checkOrigin({
        ...base,
        origin: "https://app.example.com",
        host: "10.0.0.7:3000",
        forwardedHost: "app.example.com",
      }),
    ).toEqual({ allowed: true, host: "app.example.com" });
  });

  it("uses only the first hop of a forwarded chain", () => {
    expect(
      checkOrigin({
        ...base,
        origin: "https://app.example.com",
        host: "internal",
        forwardedHost: "app.example.com, inner.svc, 10.0.0.7",
      }),
    ).toEqual({ allowed: true, host: "app.example.com" });
  });

  it("does not fall back to Host once X-Forwarded-Host is present", () => {
    // Matching Next's precedence exactly. Accepting either would be a weaker
    // rule than the framework's, which is not a trade this module should make.
    const result = checkOrigin({
      ...base,
      origin: "https://internal.example",
      host: "internal.example",
      forwardedHost: "app.example.com",
    });

    expect(result.allowed).toBe(false);
  });

  it("accepts a host on the configured allowlist", () => {
    expect(
      checkOrigin({
        origin: "https://admin.example.com",
        host: "app.example.com",
        forwardedHost: null,
        allowedHosts: ["admin.example.com"],
      }),
    ).toEqual({ allowed: true, host: "admin.example.com" });
  });

  it("matches the allowlist case-insensitively", () => {
    expect(
      checkOrigin({
        origin: "https://ADMIN.Example.COM",
        host: "app.example.com",
        forwardedHost: null,
        allowedHosts: ["admin.example.com"],
      }).allowed,
    ).toBe(true);
  });

  it("does not treat the allowlist as a suffix match", () => {
    // `evil-admin.example.com.attacker.test` must not pass because
    // `admin.example.com` is a substring of it.
    expect(
      checkOrigin({
        origin: "https://admin.example.com.attacker.test",
        host: "app.example.com",
        forwardedHost: null,
        allowedHosts: ["admin.example.com"],
      }).allowed,
    ).toBe(false);
  });

  it("distinguishes ports", () => {
    expect(
      checkOrigin({
        ...base,
        origin: "http://localhost:3001",
        host: "localhost:3000",
        forwardedHost: null,
      }).allowed,
    ).toBe(false);
  });

  it("says so when there is nothing to compare against", () => {
    const result = checkOrigin({
      ...base,
      origin: "https://app.example.com",
      host: null,
      forwardedHost: null,
    });

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(
      /no Host or X-Forwarded-Host/,
    );
  });
});

describe("parseAllowedOrigins", () => {
  it("is empty when unset", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
  });

  it("reduces full origins to their host", () => {
    expect(parseAllowedOrigins("https://app.example.com")).toEqual([
      "app.example.com",
    ]);
  });

  it("keeps the port", () => {
    expect(parseAllowedOrigins("https://app.example.com:8443")).toEqual([
      "app.example.com:8443",
    ]);
  });

  it("accepts bare hosts, which is what people actually type", () => {
    expect(parseAllowedOrigins("admin.example.com")).toEqual([
      "admin.example.com",
    ]);
  });

  it("splits on commas and trims", () => {
    expect(
      parseAllowedOrigins(" https://a.example.com , b.example.com ,, "),
    ).toEqual(["a.example.com", "b.example.com"]);
  });

  it("lowercases, because DNS names are case-insensitive", () => {
    expect(parseAllowedOrigins("HTTPS://App.Example.COM")).toEqual([
      "app.example.com",
    ]);
  });

  it("drops a malformed entry rather than throwing", () => {
    // This value is read while building an env object at import time. Throwing
    // would turn a typo in an escape hatch into a boot failure.
    expect(parseAllowedOrigins("https://, ok.example.com")).toEqual([
      "ok.example.com",
    ]);
  });
});

describe("assertSameOrigin", () => {
  const mutableEnv = env as unknown as Record<string, unknown>;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mutableEnv["ALLOWED_ACTION_ORIGINS"] = undefined;
  });

  it("passes a same-origin request", async () => {
    setRequestHeaders({
      origin: "http://localhost:3000",
      host: "localhost:3000",
    });

    await expect(assertSameOrigin()).resolves.toBeUndefined();
  });

  it("throws an ActionError the factories can turn into a result", async () => {
    setRequestHeaders({
      origin: "https://evil.example",
      host: "localhost:3000",
    });

    await expect(assertSameOrigin()).rejects.toThrow(ActionError);
    await expect(assertSameOrigin()).rejects.toThrow(ORIGIN_REJECTED_MESSAGE);
  });

  it("tells the caller nothing and the log everything", async () => {
    setRequestHeaders({
      origin: "https://evil.example",
      host: "localhost:3000",
    });

    await expect(assertSameOrigin()).rejects.toThrow(ORIGIN_REJECTED_MESSAGE);

    // The message a caller sees names neither side; a message that named the
    // expected host would tell whoever is probing exactly what to forge.
    expect(ORIGIN_REJECTED_MESSAGE).not.toMatch(/localhost/);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Origin "evil.example" does not match'),
    );
  });

  it("honours ALLOWED_ACTION_ORIGINS", async () => {
    mutableEnv["ALLOWED_ACTION_ORIGINS"] = "https://proxy.example.com";
    setRequestHeaders({
      origin: "https://proxy.example.com",
      host: "localhost:3000",
    });

    await expect(assertSameOrigin()).resolves.toBeUndefined();
  });
});
