/**
 * The counting algorithm: a sliding window counter.
 *
 * Pure, synchronous, and knows nothing about requests, headers or storage. A
 * store implementation applies it inside whatever atomic section it has (see
 * `@/lib/rate-limit/store`), and every test of the *policy* consequences —
 * "does ten in a row get refused on the eleventh" — is a test of this file
 * with numbers, not of a running server.
 *
 * ## Why not a fixed window
 *
 * A fixed window counter resets its count on a wall-clock boundary, so a
 * caller who spends its whole budget in the last instant of one window and its
 * whole budget again in the first instant of the next has made **twice the
 * limit** in requests inside a span shorter than one window. For a login
 * endpoint at ten per minute that is twenty password attempts in under a
 * second, which is the entire property the limit was meant to deny.
 *
 * ## Why not a sliding window log
 *
 * Exact, and it stores one timestamp per request. The memory an attacker can
 * make the limiter allocate is then proportional to the traffic they send,
 * which is a strange thing to build into a defence against sending too much
 * traffic.
 *
 * ## What this does instead
 *
 * Two counters — the current window and the one before it — and an estimate
 * that weights the previous window by how much of it still overlaps the
 * trailing `windowMs` from now:
 *
 *     estimate = previous × (1 − elapsed / windowMs) + current
 *
 * Three numbers per key regardless of traffic, no boundary burst, and an error
 * bound that only matters when the previous window's requests were unevenly
 * distributed inside it — the estimate assumes they were spread evenly. That
 * assumption can under- or over-count a *bursty* caller by a fraction of one
 * window's budget, and never by more than `previous`, which is itself capped
 * at the limit. It is the tradeoff Cloudflare's published analysis of this
 * algorithm measured at well under one percent of requests misclassified, and
 * it is the standard choice for exactly this reason.
 */

/** Everything a store has to persist for one key. Three numbers. */
export interface RateLimitWindow {
  /** Start of the current window, ms since epoch, aligned to a `windowMs` boundary. */
  start: number;
  /** Requests counted in the current window. */
  current: number;
  /** Requests counted in the window immediately preceding it. */
  previous: number;
}

/** The limit being applied, as far as the algorithm is concerned. */
export interface RateLimitBudget {
  /** Requests permitted per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  /**
   * Whole requests left in the budget after this one. Floored, so a caller
   * reading `RateLimit-Remaining: 0` has genuinely none rather than a
   * fractional estimate that rounds up to one.
   */
  remaining: number;
  /**
   * When the whole budget is available again — the estimate back at zero — as
   * ms since epoch. This is `RateLimit-Reset`.
   *
   * Two windows out rather than one, whenever anything has been counted in the
   * current window: at the boundary this window's count becomes the *previous*
   * count, and it takes another full window to decay out of the estimate.
   */
  resetAt: number;
  /**
   * The earliest instant one more request would be allowed, as ms since epoch.
   * Never in the past. This is `Retry-After`.
   *
   * Separate from `resetAt`, and the separation is not cosmetic — it is a bug
   * this file shipped with, found by obeying its own header against a running
   * server. `Retry-After` was the end of the current window, which reads as the
   * obvious answer and is wrong for a sliding window: a caller who spends the
   * whole budget and waits exactly that long arrives one millisecond into the
   * next window, where the previous window still overlaps almost entirely and
   * the estimate is still at the limit. They are refused again, having done
   * exactly what they were told. See `nextAllowedAt`.
   */
  retryAt: number;
  /** The window as it stands after this request. What the store writes back. */
  window: RateLimitWindow;
}

/** The window a timestamp falls in, aligned so every key shares the boundaries. */
export function windowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

/**
 * Rolls a stored window forward to `now`, discarding what has aged out.
 *
 * Three cases, and the third is the one that is easy to omit: a key that has
 * been idle for more than two windows carries counts that are entirely in the
 * past, and treating its `current` as the new `previous` would charge a caller
 * for traffic from an hour ago.
 */
export function advance(
  window: RateLimitWindow | undefined,
  now: number,
  windowMs: number,
): RateLimitWindow {
  const start = windowStart(now, windowMs);

  if (!window || window.start < start - windowMs) {
    return { start, current: 0, previous: 0 };
  }

  if (window.start === start) return window;

  // Exactly one window has elapsed: today's count becomes yesterday's.
  return { start, current: 0, previous: window.current };
}

/** The weighted estimate of requests in the trailing `windowMs` from `now`. */
export function estimate(
  window: RateLimitWindow,
  now: number,
  windowMs: number,
): number {
  const elapsed = now - window.start;
  // Clamped rather than trusted: a clock that steps backwards between the write
  // and the read would otherwise produce a weight above 1 and inflate the
  // estimate past anything the caller actually sent.
  const overlap = Math.min(1, Math.max(0, 1 - elapsed / windowMs));
  return window.previous * overlap + window.current;
}

/**
 * When the estimate returns to zero — the whole budget available again.
 *
 * Two windows out whenever the current one has counted anything, because at the
 * boundary that count becomes the *previous* count and needs another full
 * window to decay out. One window out when only the previous slot is occupied.
 */
function replenishedAt(
  window: RateLimitWindow,
  budget: RateLimitBudget,
): number {
  const windowEnd = window.start + budget.windowMs;
  if (window.current > 0) return windowEnd + budget.windowMs;
  if (window.previous > 0) return windowEnd;
  return window.start;
}

/**
 * The exact instant the estimate falls far enough for one more request, solved
 * rather than approximated.
 *
 * Let `p` be the previous window's count, `c` the current one's, and `w` the
 * fraction of the previous window still overlapping. A request is allowed when
 * `p·w + c + 1 ≤ limit`, so it becomes allowed once `w ≤ (limit − 1 − c) / p`.
 * With `w = 1 − (t − start) / windowMs`, that is linear in `t`.
 *
 * The part that is easy to get wrong — and that this file did get wrong until a
 * client obeying its `Retry-After` was refused a second time — is that solving
 * it inside the current window is not enough. When `limit − 1 − c` is negative,
 * the current window alone is already at the limit and no amount of decay in
 * the previous one helps; the obvious answer is "the end of the window", and
 * the obvious answer is wrong. At that boundary `c` becomes the new `previous`,
 * still overlapping almost entirely, and the caller is refused again one
 * millisecond in.
 *
 * So the same equation is solved a second time against the window *after* the
 * turnover, where the state is `(current 0, previous c)`. At ten per minute
 * that moves the honest answer from "60 seconds" to "66 seconds": the six
 * seconds it takes for a full window's worth of ten to decay to nine.
 */
function nextAllowedAt(
  window: RateLimitWindow,
  now: number,
  budget: RateLimitBudget,
): number {
  const { limit, windowMs } = budget;
  const windowEnd = window.start + windowMs;

  // Inside the current window, as the previous one decays.
  const headroom = limit - 1 - window.current;
  if (headroom >= 0) {
    if (window.previous <= 0 || headroom >= window.previous) return now;
    const at = window.start + windowMs * (1 - headroom / window.previous);
    if (at < windowEnd) return Math.max(now, at);
  }

  // In the window after the turnover, where `current` becomes `previous` and
  // the count starts again from zero.
  const nextHeadroom = limit - 1;
  if (window.current <= nextHeadroom) return windowEnd;

  return windowEnd + windowMs * (1 - nextHeadroom / window.current);
}

/**
 * Applies one request to a window and answers whether it is allowed.
 *
 * The returned `window` is what the store must persist. It is a new object
 * whether or not the request was allowed, so a caller cannot accidentally
 * mutate the stored one — and a **refused** request does not increment the
 * count. That is deliberate: counting refusals would let a caller who keeps
 * hammering a limit hold themselves out past the window they were supposed to
 * be readmitted in, which turns a rate limit into an escalating ban. If that is
 * what a deployment wants, it is a different policy and should say so.
 */
export function consume(
  stored: RateLimitWindow | undefined,
  now: number,
  budget: RateLimitBudget,
): RateLimitDecision {
  const window = advance(stored, now, budget.windowMs);
  const used = estimate(window, now, budget.windowMs);
  const allowed = used + 1 <= budget.limit;

  const next: RateLimitWindow = {
    start: window.start,
    current: allowed ? window.current + 1 : window.current,
    previous: window.previous,
  };

  return {
    allowed,
    limit: budget.limit,
    remaining: Math.max(
      0,
      Math.floor(budget.limit - (allowed ? used + 1 : used)),
    ),
    resetAt: Math.max(now, replenishedAt(next, budget)),
    retryAt: nextAllowedAt(next, now, budget),
    window: next,
  };
}
