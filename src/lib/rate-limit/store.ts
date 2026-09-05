/**
 * Where the counters live.
 *
 * ## The interface is the deliverable, the implementation is the default
 *
 * A rate limit is only as strong as the store behind it, and the store a
 * deployment needs depends on how many processes serve its traffic. So this
 * module ships a one-method interface plus an in-memory implementation, and is
 * explicit about what that implementation is and is not:
 *
 *   **`MemoryRateLimitStore` is per-process.** A deployment running four server
 *   instances behind a load balancer enforces four times every limit in this
 *   repository, because each instance counts only what it saw. On a platform
 *   that runs the proxy as a serverless function, it is worse than that — an
 *   instance that has just been created has counted nothing at all.
 *
 * That is a real limitation and it is not a reason to ship nothing. A
 * per-process limit still refuses the single-source floods that make up most of
 * what hits a public endpoint, and a boilerplate cannot assume a Redis. What it
 * *can* do is make swapping in a shared store a one-line change, which is what
 * `RateLimitStore` is for. `docs/rate-limiting.md` carries a worked Redis
 * implementation and the one property it must have.
 *
 * ## Why `consume` and not `get`/`set`
 *
 * Because the read-modify-write has to be atomic, and only the store knows how
 * to make it so. Exposing `get` and `set` would put the sequence in the caller,
 * where two concurrent requests interleave as read-read-write-write and the
 * second write erases the first — under exactly the concurrent load a rate
 * limiter exists to handle, and with the failure biased towards *under*
 * counting. Single-threaded JavaScript does not save an implementation whose
 * `get` is an `await`. So the algorithm from `@/lib/rate-limit/window` is
 * applied *inside* the store, and a Redis implementation applies it inside a
 * Lua script for the same reason.
 */
import { consume } from "@/lib/rate-limit/window";
import type {
  RateLimitBudget,
  RateLimitDecision,
  RateLimitWindow,
} from "@/lib/rate-limit/window";

export interface RateLimitStore {
  /**
   * Atomically counts one request against `key` and answers whether it is
   * allowed.
   *
   * `now` is passed in rather than read from the clock so that the caller's
   * single timestamp is used for the decision, the headers and the log line —
   * three reads of `Date.now()` produce three slightly different answers, and
   * a `Retry-After` computed from a later instant than the decision is a
   * `Retry-After` that is subtly too short.
   */
  consume(
    key: string,
    budget: RateLimitBudget,
    now: number,
  ): Promise<RateLimitDecision>;
}

export interface MemoryRateLimitStoreOptions {
  /**
   * How many keys to hold before evicting.
   *
   * There has to be a cap. The keys are derived from client addresses, so an
   * attacker with a range to spend chooses how many distinct ones exist, and an
   * unbounded `Map` turns a rate limiter into the memory-exhaustion vector it
   * was installed to prevent.
   */
  maxKeys?: number;
}

/** Two windows past its start, an entry can no longer affect any estimate. */
function isStale(window: RateLimitWindow, now: number, windowMs: number) {
  return now >= window.start + windowMs * 2;
}

/**
 * The default store: a `Map` in the server process.
 *
 * Eviction is lazy and happens only when the cap is reached, because sweeping
 * on a timer means holding a timer open in a serverless process and sweeping on
 * every request means walking the whole map to serve one.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly #windows = new Map<string, RateLimitWindow>();
  readonly #budgets = new Map<string, number>();
  readonly #maxKeys: number;

  constructor(options: MemoryRateLimitStoreOptions = {}) {
    this.#maxKeys = options.maxKeys ?? 10_000;
  }

  /** Keys currently held. Exposed for the eviction tests and for diagnostics. */
  get size(): number {
    return this.#windows.size;
  }

  async consume(
    key: string,
    budget: RateLimitBudget,
    now: number,
  ): Promise<RateLimitDecision> {
    const decision = consume(this.#windows.get(key), now, budget);

    // Delete before set, so that re-inserting an existing key moves it to the
    // end of the Map's insertion order. Without it the order is "first seen"
    // rather than "least recently seen", and the eviction below would drop the
    // busiest keys — the ones the limiter most needs to remember — first.
    this.#windows.delete(key);
    this.#windows.set(key, decision.window);
    this.#budgets.set(key, budget.windowMs);

    if (this.#windows.size > this.#maxKeys) this.#evict(now);

    return decision;
  }

  /**
   * Drops stale entries, then, if that was not enough, the least recently used
   * ones until the map is back under its cap.
   *
   * The second half is the part that matters under attack: when every entry is
   * live, there is nothing to expire and something still has to go. Evicting
   * the least recently used means the key being dropped is the one whose
   * counter was least likely to be consulted next, and a dropped counter fails
   * *open* for that key — one caller regains their budget early. That is the
   * right direction to fail: the alternative, refusing to record anything new,
   * would let an attacker fill the map and thereby exempt every client that
   * arrives afterwards.
   */
  #evict(now: number): void {
    for (const [key, window] of this.#windows) {
      const windowMs = this.#budgets.get(key);
      if (windowMs !== undefined && isStale(window, now, windowMs)) {
        this.#windows.delete(key);
        this.#budgets.delete(key);
      }
    }

    for (const key of this.#windows.keys()) {
      if (this.#windows.size <= this.#maxKeys) break;
      this.#windows.delete(key);
      this.#budgets.delete(key);
    }
  }

  /** Forgets everything. For tests; nothing in the request path calls it. */
  clear(): void {
    this.#windows.clear();
    this.#budgets.clear();
  }
}

/**
 * The process-wide store the proxy uses.
 *
 * Module scope is deliberate and is the one piece of shared mutable state in
 * this feature: a limiter whose counters are created per request counts to one
 * and allows everything. It is safe here for the reason the equivalent variable
 * in `runHardenedAction` is not — nothing about it is request-scoped, so
 * concurrent requests sharing it is the point rather than a leak.
 */
export const rateLimitStore: RateLimitStore = new MemoryRateLimitStore();
