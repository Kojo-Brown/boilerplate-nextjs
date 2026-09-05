import { describe, expect, it } from "vitest";
import {
  advance,
  consume,
  estimate,
  windowStart,
} from "@/lib/rate-limit/window";
import type { RateLimitBudget, RateLimitWindow } from "@/lib/rate-limit/window";

const budget: RateLimitBudget = { limit: 10, windowMs: 60_000 };

/** Spends `count` requests starting at `from`, one per millisecond. */
function spend(
  count: number,
  from: number,
  start: RateLimitWindow | undefined = undefined,
) {
  let window = start;
  let allowed = 0;

  for (let index = 0; index < count; index += 1) {
    const decision = consume(window, from + index, budget);
    window = decision.window;
    if (decision.allowed) allowed += 1;
  }

  return { window, allowed };
}

describe("windowStart", () => {
  it("aligns to a multiple of the window length", () => {
    expect(windowStart(60_000, 60_000)).toBe(60_000);
    expect(windowStart(60_001, 60_000)).toBe(60_000);
    expect(windowStart(119_999, 60_000)).toBe(60_000);
    expect(windowStart(120_000, 60_000)).toBe(120_000);
  });
});

describe("advance", () => {
  it("starts an empty window when there is nothing stored", () => {
    expect(advance(undefined, 90_000, 60_000)).toEqual({
      start: 60_000,
      current: 0,
      previous: 0,
    });
  });

  it("returns the stored window untouched inside it", () => {
    const stored: RateLimitWindow = { start: 60_000, current: 4, previous: 2 };
    expect(advance(stored, 90_000, 60_000)).toBe(stored);
  });

  it("rolls the current count into the previous slot one window on", () => {
    const stored: RateLimitWindow = { start: 60_000, current: 4, previous: 9 };
    expect(advance(stored, 130_000, 60_000)).toEqual({
      start: 120_000,
      current: 0,
      previous: 4,
    });
  });

  it("discards both counts after an idle gap of more than one window", () => {
    // The case an implementation omits: two windows on, `current` is no longer
    // "the previous window", it is ancient history. Carrying it would charge a
    // caller for traffic that has completely aged out.
    const stored: RateLimitWindow = {
      start: 60_000,
      current: 10,
      previous: 10,
    };
    expect(advance(stored, 200_000, 60_000)).toEqual({
      start: 180_000,
      current: 0,
      previous: 0,
    });
  });
});

describe("estimate", () => {
  it("weights the previous window by how much of it still overlaps", () => {
    const window: RateLimitWindow = { start: 60_000, current: 2, previous: 8 };
    // A quarter of the way in: three quarters of the previous window is still
    // inside the trailing minute.
    expect(estimate(window, 75_000, 60_000)).toBeCloseTo(8 * 0.75 + 2);
    expect(estimate(window, 60_000, 60_000)).toBeCloseTo(10);
    expect(estimate(window, 119_999, 60_000)).toBeCloseTo(2, 2);
  });

  it("clamps the overlap when the clock steps backwards", () => {
    const window: RateLimitWindow = { start: 60_000, current: 1, previous: 8 };
    // `now` before the window it is stored against would give a weight above 1
    // and count more requests than the caller ever made.
    expect(estimate(window, 30_000, 60_000)).toBe(9);
  });
});

describe("consume", () => {
  it("allows exactly the limit and refuses the next", () => {
    const { window, allowed } = spend(10, 60_000);
    expect(allowed).toBe(10);

    const eleventh = consume(window, 60_011, budget);
    expect(eleventh.allowed).toBe(false);
    expect(eleventh.remaining).toBe(0);
  });

  it("reports the remaining budget as it falls", () => {
    const first = consume(undefined, 60_000, budget);
    expect(first.remaining).toBe(9);

    const second = consume(first.window, 60_001, budget);
    expect(second.remaining).toBe(8);
  });

  it("does not count a refused request", () => {
    const { window } = spend(10, 60_000);

    const refused = consume(window, 60_020, budget);
    expect(refused.window.current).toBe(10);

    // If refusals were counted, hammering the endpoint would keep pushing the
    // readmission time out and turn a rate limit into an escalating ban.
    const second = consume(refused.window, 60_021, budget);
    expect(second.window.current).toBe(10);
  });

  it("refuses the boundary burst a fixed window would allow", () => {
    // The whole budget in the last instant of one window...
    const first = spend(10, 119_990);
    expect(first.allowed).toBe(10);

    // ...and one more request a millisecond into the next. A fixed-window
    // counter resets here and allows ten more, for twenty attempts inside
    // twenty milliseconds.
    const next = consume(first.window, 120_001, budget);
    expect(next.allowed).toBe(false);
  });

  it("readmits the caller as the previous window decays", () => {
    const { window } = spend(10, 60_000);

    // A millisecond past the boundary buys nothing: the previous window still
    // overlaps almost entirely, which is the burst a fixed window would allow.
    expect(consume(window, 120_001, budget).allowed).toBe(false);

    // Halfway through the next window, half of the previous window's ten
    // requests still count, so five of the ten are free again.
    const halfway = spend(5, 150_000, window);
    expect(halfway.allowed).toBe(5);
    expect(consume(halfway.window, 150_010, budget).allowed).toBe(false);
  });

  it("recovers the full budget after two idle windows", () => {
    const { window } = spend(10, 60_000);
    const later = spend(10, 200_000, window);
    expect(later.allowed).toBe(10);
  });

  describe("resetAt — when the whole budget is back", () => {
    it("is two windows out once anything has been counted in this one", () => {
      // Not one: at the boundary this window's count becomes the *previous*
      // count and needs another full window to decay out of the estimate.
      const decision = consume(undefined, 75_000, budget);
      expect(decision.resetAt).toBe(180_000);
    });

    it("is one window out when only the previous slot is occupied", () => {
      // A refused request leaves `current` at zero, so there is only the
      // previous window left to age out.
      const stored: RateLimitWindow = {
        start: 120_000,
        current: 0,
        previous: 10,
      };
      const decision = consume(stored, 120_000, budget);

      expect(decision.allowed).toBe(false);
      expect(decision.resetAt).toBe(180_000);
    });

    it("never points into the past", () => {
      const stored: RateLimitWindow = {
        start: 120_000,
        current: 9,
        previous: 10,
      };
      expect(consume(stored, 179_000, budget).resetAt).toBeGreaterThanOrEqual(
        179_000,
      );
    });
  });

  describe("retryAt — when one more would get through", () => {
    it("is the exact instant the decaying window frees a slot", () => {
      // Ten in the previous window, none in this one. One more is allowed once
      // the previous window's weight drops to 9/10, which is one tenth of the
      // way into the current window.
      const stored: RateLimitWindow = {
        start: 120_000,
        current: 0,
        previous: 10,
      };
      const decision = consume(stored, 120_000, budget);

      expect(decision.allowed).toBe(false);
      expect(decision.retryAt).toBeCloseTo(126_000, 5);
      expect(consume(stored, decision.retryAt, budget).allowed).toBe(true);
    });

    it("looks past the boundary when this window alone is at the limit", () => {
      // The bug this field exists for, found by obeying the header against a
      // running server. The obvious answer is "the end of the window" — and a
      // caller who waits exactly that long arrives one millisecond into the
      // next window, where these ten are the previous count, still overlapping
      // almost entirely, and is refused again having done as they were told.
      const stored: RateLimitWindow = {
        start: 120_000,
        current: 10,
        previous: 0,
      };
      const decision = consume(stored, 130_000, budget);

      expect(consume(stored, 180_000, budget).allowed).toBe(false);
      // Six seconds past the boundary: the time it takes a full window's ten to
      // decay to nine.
      expect(decision.retryAt).toBeCloseTo(186_000, 5);
      expect(consume(stored, decision.retryAt, budget).allowed).toBe(true);
    });

    it("holds for every point at which a full budget is spent", () => {
      // The property, rather than one case of it: whatever instant the caller
      // is refused at, waiting until `retryAt` gets them through.
      for (const at of [60_000, 75_500, 90_000, 110_000, 119_999]) {
        const { window } = spend(10, at);
        const refused = consume(window, at + 10, budget);

        expect(refused.allowed).toBe(false);
        expect(consume(window, refused.retryAt, budget).allowed).toBe(true);
      }
    });

    it("is now when the caller is not being refused", () => {
      expect(consume(undefined, 75_000, budget).retryAt).toBe(75_000);
    });
  });

  it("treats a limit of one as one request per window", () => {
    const first = consume(undefined, 60_000, { limit: 1, windowMs: 1_000 });
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(0);
    expect(
      consume(first.window, 60_500, { limit: 1, windowMs: 1_000 }).allowed,
    ).toBe(false);
  });

  it("does not mutate the window it was given", () => {
    const stored: RateLimitWindow = { start: 60_000, current: 3, previous: 0 };
    const decision = consume(stored, 60_100, budget);

    expect(stored.current).toBe(3);
    expect(decision.window).not.toBe(stored);
  });
});
