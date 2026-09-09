import { describe, it, expect, vi } from "vitest";
import { createBatchLoader } from "./batch";

interface Row {
  id: string;
  name: string;
}

const row = (id: string): Row => ({ id, name: `name:${id}` });

/**
 * Builds a loader over an in-memory table, and hands back the spy so a test can
 * assert how many statements it took.
 */
function makeLoader(
  rows: readonly Row[],
  options: { maxBatchSize?: number } = {},
) {
  const fetch = vi.fn(async (keys: readonly string[]) =>
    rows.filter((r) => keys.includes(r.id)),
  );
  const loader = createBatchLoader<string, Row>({
    name: "test",
    keyOf: (r) => r.id,
    fetch,
    ...(options.maxBatchSize === undefined
      ? {}
      : { maxBatchSize: options.maxBatchSize }),
  });
  return { loader, fetch };
}

describe("createBatchLoader", () => {
  it("coalesces concurrent loads of distinct keys into one fetch", async () => {
    const { loader, fetch } = makeLoader([row("a"), row("b"), row("c")]);

    const results = await Promise.all([
      loader.load("a"),
      loader.load("b"),
      loader.load("c"),
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(["a", "b", "c"]);
    expect(results.map((r) => r?.id)).toEqual(["a", "b", "c"]);
  });

  it("coalesces loads issued from separate call sites in the same tick", async () => {
    // The shape that matters: nothing here is aware of the other calls, which
    // is exactly the position two sibling components are in.
    const { loader, fetch } = makeLoader([row("a"), row("b")]);

    const first = loader.load("a");
    const second = loader.load("b");
    await Promise.all([first, second]);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks for a key once no matter how many callers want it", async () => {
    const { loader, fetch } = makeLoader([row("a")]);

    const results = await Promise.all([
      loader.load("a"),
      loader.load("a"),
      loader.load("a"),
    ]);

    expect(fetch).toHaveBeenCalledWith(["a"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Same row object, not three equal copies: callers may compare by identity.
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });

  it("serves a key asked for later in the request without a second fetch", async () => {
    const { loader, fetch } = makeLoader([row("a")]);

    await loader.load("a");
    await loader.load("a");

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("resolves a key with no row as null rather than throwing", async () => {
    const { loader, fetch } = makeLoader([row("a")]);

    const [found, missing] = await Promise.all([
      loader.load("a"),
      loader.load("gone"),
    ]);

    expect(found?.id).toBe("a");
    expect(missing).toBeNull();
    // One statement, and the absent row is absent from the result — a loader
    // that split the misses out would be back to one query per key.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not batch across ticks", async () => {
    // Deliberate, and the reason the loader is worth having at all: it batches
    // what a synchronous pass asks for and never delays a read waiting for one
    // that may not come.
    const { loader, fetch } = makeLoader([row("a"), row("b")]);

    await loader.load("a");
    await loader.load("b");

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("starts a new batch for a key requested from inside a fetch", async () => {
    // A re-entrant load must not be appended to a batch that has already been
    // dispatched, which would leave it pending until the request ended.
    const seen: string[][] = [];
    // A holder rather than a `let`, so the closure can reach the loader that
    // does not exist yet without the binding being reassignable afterwards.
    const holder: {
      loader?: ReturnType<typeof createBatchLoader<string, Row>>;
    } = {};
    const fetch = vi.fn(async (keys: readonly string[]) => {
      seen.push([...keys]);
      if (keys.includes("a")) {
        // Issued while the first batch is in flight.
        void holder.loader?.load("b");
      }
      return keys.map(row);
    });
    const loader = createBatchLoader<string, Row>({
      name: "reentrant",
      keyOf: (r) => r.id,
      fetch,
    });
    holder.loader = loader;

    await loader.load("a");
    expect(await loader.load("b")).toEqual(row("b"));
    expect(seen).toEqual([["a"], ["b"]]);
  });

  it("splits a batch larger than maxBatchSize", async () => {
    const rows = ["a", "b", "c", "d", "e"].map(row);
    const { loader, fetch } = makeLoader(rows, { maxBatchSize: 2 });

    const results = await loader.loadMany(["a", "b", "c", "d", "e"]);

    expect(fetch.mock.calls.map(([keys]) => keys)).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
    expect(results.map((r) => r?.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("rejects a non-positive maxBatchSize rather than looping forever", () => {
    expect(() =>
      createBatchLoader<string, Row>({
        name: "bad",
        keyOf: (r) => r.id,
        fetch: async () => [],
        maxBatchSize: 0,
      }),
    ).toThrow(/positive integer/);
  });

  it("fails every caller in a batch when the fetch rejects", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connection lost");
    });
    const loader = createBatchLoader<string, Row>({
      name: "failing",
      keyOf: (r: Row) => r.id,
      fetch,
    });

    const results = await Promise.allSettled([
      loader.load("a"),
      loader.load("b"),
    ]);

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });

  it("does not cache a rejection, so a later read can succeed", async () => {
    // A cached rejected promise would make every later load of that key in the
    // request fail with an error raised by a query it never issued.
    let attempt = 0;
    const loader = createBatchLoader<string, Row>({
      name: "flaky",
      keyOf: (r: Row) => r.id,
      fetch: async (keys) => {
        attempt += 1;
        if (attempt === 1) throw new Error("connection lost");
        return keys.map(row);
      },
    });

    await expect(loader.load("a")).rejects.toThrow("connection lost");
    await expect(loader.load("a")).resolves.toEqual(row("a"));
  });

  it("rejects when fetch returns a row that was never requested", async () => {
    // The `where` clause does not say what the caller thinks it says. Handing
    // the row back would let a loader keyed on ownership return somebody
    // else's row, so this is an error rather than a silently ignored extra.
    const loader = createBatchLoader<string, Row>({
      name: "leaky",
      keyOf: (r: Row) => r.id,
      fetch: async () => [row("a"), row("intruder")],
    });

    await expect(loader.load("a")).rejects.toThrow(/not requested/);
  });

  it("loadMany answers positionally, including duplicates and misses", async () => {
    const { loader, fetch } = makeLoader([row("a"), row("b")]);

    const results = await loader.loadMany(["b", "missing", "a", "b"]);

    expect(results.map((r) => r?.id ?? null)).toEqual(["b", null, "a", "b"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(["b", "missing", "a"]);
  });

  it("does not emit an unhandled rejection for an abandoned load", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const loader = createBatchLoader<string, Row>({
        name: "abandoned",
        keyOf: (r: Row) => r.id,
        fetch: async () => {
          throw new Error("connection lost");
        },
      });

      // Nobody awaits it. Without the no-op handler the loader attaches, this
      // takes the process down under `--unhandled-rejections=throw`.
      void loader.load("a");
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
