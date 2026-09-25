import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * The public half of the environment schema.
 *
 * Small on purpose: this module exists to be importable from a browser, so
 * everything about it is a statement about what it does *not* contain. The
 * boundary itself — that nothing here reaches `./server` — is checked by
 * `scripts/assert-server-only.ts`, which can see the module graph that a unit
 * test cannot.
 */
async function loadEnv(): Promise<typeof import("./client").clientEnv> {
  vi.resetModules();
  const loaded = await import("./client");
  return loaded.clientEnv;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("clientEnv", () => {
  it("defaults the app URL for a fresh clone", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);

    expect((await loadEnv()).NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
  });

  it("treats an empty analytics domain as unset", async () => {
    // `NEXT_PUBLIC_PLAUSIBLE_DOMAIN=` in a `.env` file sets the variable to the
    // empty string, which is present. Without the preprocessing that mounts the
    // analytics script with an empty `data-domain`, reporting every page view
    // under no site at all.
    vi.stubEnv("NEXT_PUBLIC_PLAUSIBLE_DOMAIN", "");

    expect((await loadEnv()).NEXT_PUBLIC_PLAUSIBLE_DOMAIN).toBeUndefined();
  });

  it("keeps a configured analytics domain", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLAUSIBLE_DOMAIN", "example.com");

    expect((await loadEnv()).NEXT_PUBLIC_PLAUSIBLE_DOMAIN).toBe("example.com");
  });

  it("refuses an app URL that is not one", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "not-a-url");

    await expect(loadEnv()).rejects.toThrow(
      "Invalid public environment variables",
    );
  });

  it("carries no server variable", async () => {
    vi.stubEnv(
      "NEXTAUTH_SECRET",
      "a-secret-that-is-at-least-32-characters-long",
    );

    const env = await loadEnv();

    // Not a tautology about the schema: `client.safeParse` is handed an object
    // literal of the two public names rather than a spread of `process.env`,
    // which is what keeps a secret from arriving here even if someone adds it to
    // the schema. Zod strips unknown keys, and this is the assertion that says
    // the stripping is load-bearing.
    expect(Object.keys(env)).toEqual([
      "NEXT_PUBLIC_APP_URL",
      "NEXT_PUBLIC_PLAUSIBLE_DOMAIN",
    ]);
  });
});
