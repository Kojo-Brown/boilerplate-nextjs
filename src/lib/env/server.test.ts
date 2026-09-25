import { describe, it, expect, afterEach, vi } from "vitest";
import { SECRET_KEYS } from "./server";

/**
 * The server half of the environment schema, exercised by re-importing it under
 * a stubbed `process.env`.
 *
 * `server.ts` validates at module scope and throws on failure, so there is
 * nothing to call — the module's evaluation *is* the behaviour.
 * `vi.resetModules()` before each import is what makes a second evaluation
 * happen rather than a cache hit.
 *
 * Most cases here are about the optional secrets, because that is where the
 * schema had a defect that made the documented setup path fail.
 */
async function loadEnv(): Promise<typeof import("./server").serverEnv> {
  vi.resetModules();
  // Not destructured into a binding called `module`: `@next/next/no-assign-module-variable`
  // rejects that name outright, since it shadows CommonJS's `module`.
  const loaded = await import("./server");
  return loaded.serverEnv;
}

const VALID_SECRET = "a-secret-that-is-at-least-32-characters-long";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("optional secrets", () => {
  it("treats an empty value as unset", async () => {
    // The defect. `.env.example` ships `PREVIEW_SECRET=` for every optional
    // secret and `README.md` opens with `cp .env.example .env`, so the
    // documented first step produced `Invalid environment variables` and a
    // process that would not boot: dotenv sets the variable to `""`, which is
    // *present*, so `.optional()` never applied and `.min(32)` rejected it.
    vi.stubEnv("PREVIEW_SECRET", "");
    vi.stubEnv("REVALIDATE_SECRET", "");

    const env = await loadEnv();

    expect(env.PREVIEW_SECRET).toBeUndefined();
    expect(env.REVALIDATE_SECRET).toBeUndefined();
  });

  it("keeps a real value", async () => {
    vi.stubEnv("REVALIDATE_SECRET", VALID_SECRET);

    expect((await loadEnv()).REVALIDATE_SECRET).toBe(VALID_SECRET);
  });

  it("still rejects a short one", async () => {
    // "Unset" and "set to something too short to be a key" are different, and
    // only the first is allowed — relaxing the length would have made the
    // empty-string case pass for the wrong reason.
    vi.stubEnv("REVALIDATE_SECRET", "too-short");

    await expect(loadEnv()).rejects.toThrow("Invalid environment variables");
  });

  it("leaves them undefined when the variables are absent entirely", async () => {
    vi.stubEnv("PREVIEW_SECRET", undefined);
    vi.stubEnv("REVALIDATE_SECRET", undefined);

    const env = await loadEnv();

    expect(env.PREVIEW_SECRET).toBeUndefined();
    expect(env.REVALIDATE_SECRET).toBeUndefined();
  });
});

describe("SECRET_KEYS", () => {
  /**
   * The list two gates work from, checked against the schema it claims to be a
   * subset of.
   *
   * `scripts/assert-server-only.ts` and the `server-only/no-secret-env-access`
   * ESLint rule both read this array out of the source text and refuse a raw
   * `process.env` read of anything in it. A name that is misspelled, or left
   * behind by a rename, silently stops being enforced — both readers would
   * simply never match it — and nothing else in the repository would notice.
   */
  it("names only keys the schema actually parses", async () => {
    for (const key of SECRET_KEYS) {
      vi.stubEnv(
        key,
        key === "DATABASE_URL" ? "postgresql://u@h/db" : VALID_SECRET,
      );
    }

    const env = await loadEnv();

    for (const key of SECRET_KEYS) {
      expect(Object.keys(env)).toContain(key);
    }
  });

  it("does not name a public variable", async () => {
    // A `NEXT_PUBLIC_*` name here would be a contradiction: those are
    // substituted into the client bundle by design, so a rule forbidding reads
    // of one would fail on the code that is supposed to read it.
    for (const key of SECRET_KEYS) {
      expect(key).not.toMatch(/^NEXT_PUBLIC_/);
    }
  });
});
