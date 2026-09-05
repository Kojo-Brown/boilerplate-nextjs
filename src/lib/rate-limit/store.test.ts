import { describe, expect, it } from "vitest";
import { MemoryRateLimitStore } from "@/lib/rate-limit/store";
import type { RateLimitBudget } from "@/lib/rate-limit/window";

const budget: RateLimitBudget = { limit: 3, windowMs: 60_000 };

describe("MemoryRateLimitStore", () => {
  it("counts a key across calls", async () => {
    const store = new MemoryRateLimitStore();

    expect((await store.consume("a", budget, 60_000)).allowed).toBe(true);
    expect((await store.consume("a", budget, 60_001)).allowed).toBe(true);
    expect((await store.consume("a", budget, 60_002)).allowed).toBe(true);
    expect((await store.consume("a", budget, 60_003)).allowed).toBe(false);
  });

  it("keeps keys independent", async () => {
    const store = new MemoryRateLimitStore();

    for (let index = 0; index < 3; index += 1) {
      await store.consume("a", budget, 60_000 + index);
    }

    expect((await store.consume("a", budget, 60_010)).allowed).toBe(false);
    expect((await store.consume("b", budget, 60_010)).allowed).toBe(true);
  });

  it("serialises concurrent consumes of one key", async () => {
    // The property the `consume`-not-`get`/`set` interface exists for. Ten
    // callers race on a budget of three; exactly three may win. A store that
    // exposed a read and a write would let the interleaving decide.
    const store = new MemoryRateLimitStore();

    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => store.consume("a", budget, 60_000)),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
  });

  it("evicts stale keys once the cap is reached", async () => {
    const store = new MemoryRateLimitStore({ maxKeys: 4 });

    for (const key of ["a", "b", "c", "d"]) {
      await store.consume(key, budget, 60_000);
    }
    expect(store.size).toBe(4);

    // Three windows on, every one of those four has aged out of any estimate.
    await store.consume("e", budget, 60_000 + budget.windowMs * 3);
    expect(store.size).toBe(1);
  });

  it("evicts the least recently used when nothing is stale", async () => {
    const store = new MemoryRateLimitStore({ maxKeys: 3 });

    await store.consume("a", budget, 60_000);
    await store.consume("b", budget, 60_001);
    await store.consume("c", budget, 60_002);
    // Touching "a" again must move it to the back of the queue, or the busiest
    // key in the store is the first one dropped.
    await store.consume("a", budget, 60_003);

    await store.consume("d", budget, 60_004);

    expect(store.size).toBe(3);
    // "b" was the oldest untouched key, so it is the one that went: its counter
    // starts from scratch.
    expect((await store.consume("b", budget, 60_005)).remaining).toBe(2);
    // "a" survived, with both of its requests still counted.
    expect((await store.consume("a", budget, 60_006)).remaining).toBe(0);
  });

  it("stays within its cap under a flood of distinct keys", async () => {
    // The scenario the cap is for: an attacker with an address range picks how
    // many keys exist, and an unbounded Map turns the limiter into the
    // memory-exhaustion vector it was installed to prevent.
    const store = new MemoryRateLimitStore({ maxKeys: 50 });

    for (let index = 0; index < 5_000; index += 1) {
      await store.consume(`client-${index}`, budget, 60_000 + index);
    }

    expect(store.size).toBeLessThanOrEqual(51);
  });

  it("forgets everything on clear", async () => {
    const store = new MemoryRateLimitStore();

    for (let index = 0; index < 3; index += 1) {
      await store.consume("a", budget, 60_000 + index);
    }
    store.clear();

    expect(store.size).toBe(0);
    expect((await store.consume("a", budget, 60_010)).allowed).toBe(true);
  });
});
