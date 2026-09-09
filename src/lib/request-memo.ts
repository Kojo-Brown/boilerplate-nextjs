import { cache } from "react";

/**
 * Request-scoped memoisation for data-access functions.
 *
 * ## The problem this exists for
 *
 * A server component asks for what it renders. That is the whole point of the
 * model, and it is also how this application ended up issuing five queries
 * against `posts` for one user on a single `/dashboard` request: `@stats`
 * counted the user's posts and their published ones, `@notifications` counted
 * the unpublished ones and read the most recently edited, and `@activity` read
 * the five newest. Nothing was wrong with any of them individually and nothing
 * shared anything, because parallel routes and Suspense boundaries render
 * independently — which is the property that makes them useful and the property
 * that makes duplicate reads invisible.
 *
 * That shape is the App Router's version of an N+1. The classic one — a list
 * that queries once per row — this codebase avoids by construction, because
 * every list read pulls its relation through `select`. The one it had instead
 * is a *fan-out*: N components, each reading the same thing, none of them able
 * to see the others.
 *
 * ## Why React's `cache` rather than a module-level map
 *
 * A `Map` at module scope lives for the life of the process and is shared by
 * every request it serves, so caching `getPostsByUser(userId)` in one would
 * serve the first user's posts to the second. `cache()` is memoised per
 * *request* by React, which is exactly the lifetime a read of per-user data may
 * have. Nothing outside a render shares an entry with anything.
 *
 * ## Three things that are load-bearing
 *
 * **Arguments are compared by identity.** React keys the memo on the argument
 * list with `SameValueZero`, so `find({ userId })` called twice creates two
 * object literals, misses, and runs twice — a memoised read that silently
 * memoises nothing. Every function wrapped here takes primitives, and
 * `assert-no-n-plus-one.ts` rule R4 fails a wrapped signature that does not.
 *
 * **Outside a React render, `cache` does not memoise at all.** It is not a
 * global cache with a request-scoped key; without a request store there is
 * nothing to key on, and each call gets a fresh cache. Two consequences.
 * Scripts, seeds and the unit suite behave exactly as they did before this
 * wrapper existed — which is why no test in this repository asserts that a
 * memoised read runs once, and why the deduplication is verified by counting
 * statements against a live Postgres instead (see `docs/n-plus-one.md`).
 *
 * **A memoised read is a read, and a request that writes must not use one.**
 * Within one request the second call returns the first call's value, so a
 * `write → read` sequence gets the state from before the write. That is a
 * correctness bug, not a stale cache, and it is why `uncached` exists and why
 * `updatePostAction`'s conflict re-read goes through it.
 */
export type Memoized<A extends readonly unknown[], R> = ((...args: A) => R) & {
  /**
   * The unwrapped function.
   *
   * For the one situation memoisation gets wrong: reading *after* writing
   * inside the same request. A Server Action that updates a row and then reads
   * it back through the memoised entry point gets whatever an earlier read in
   * that same request put in the cache — which, on the path where it matters,
   * is the row as it was before the write.
   *
   * Spelled at the call site rather than solved by not memoising, because the
   * cost is asymmetric: memoising the render path saves a query on every
   * request, and the write-then-read path is rare, always deliberate, and
   * always in a `"use server"` module where the author is already thinking
   * about ordering. `assert-no-n-plus-one.ts` R5 requires each use to carry a
   * comment saying why.
   */
  readonly uncached: (...args: A) => R;
};

/**
 * Wraps a read so that every caller in one request shares one execution.
 *
 * Use it for anything a server component reads. Do not use it for a function
 * that writes, and do not use it for one whose result depends on something
 * other than its arguments — `cache` has no way to know that the second call
 * meant something different from the first.
 */
export function requestMemo<A extends readonly unknown[], R>(
  fn: (...args: A) => R,
): Memoized<A, R> {
  // `cache` types its argument and return as the same function type, so the
  // cast is to attach `uncached` — not to change what the value is.
  const memoized = cache(fn) as (...args: A) => R;
  return Object.assign(memoized, { uncached: fn });
}
