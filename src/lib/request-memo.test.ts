import { describe, it, expect, vi } from "vitest";
import { requestMemo } from "./request-memo";

describe("requestMemo", () => {
  it("returns what the wrapped function returns", async () => {
    const memoized = requestMemo(async (id: string) => `value:${id}`);

    expect(await memoized("a")).toBe("value:a");
  });

  it("exposes the unwrapped function as `uncached`", async () => {
    const spy = vi.fn(async (id: string) => `value:${id}`);
    const memoized = requestMemo(spy);

    expect(await memoized.uncached("a")).toBe("value:a");
    expect(spy).toHaveBeenCalledWith("a");
  });

  it("does not memoise outside a React render", async () => {
    // Not an accident and not a limitation to work around — it is why wrapping
    // the data layer changed nothing about how the rest of this suite, the
    // seed script and the CI gates behave. `cache` keys its memo on the
    // request React is rendering; with no request there is nothing to key on,
    // so each call gets a fresh cache.
    //
    // The consequence for tests is that no test in this repository can assert
    // the deduplication itself. `docs/n-plus-one.md` records the statement
    // counts measured against a live Postgres instead.
    const spy = vi.fn(async (id: string) => `value:${id}`);
    const memoized = requestMemo(spy);

    await memoized("a");
    await memoized("a");

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("passes every argument through", async () => {
    const spy = vi.fn(async (id: string, limit: number) => `${id}:${limit}`);
    const memoized = requestMemo(spy);

    expect(await memoized("a", 5)).toBe("a:5");
    expect(spy).toHaveBeenCalledWith("a", 5);
  });

  it("propagates a rejection rather than swallowing it", async () => {
    const memoized = requestMemo(async () => {
      throw new Error("read failed");
    });

    await expect(memoized()).rejects.toThrow("read failed");
  });
});
