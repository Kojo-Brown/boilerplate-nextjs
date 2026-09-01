/**
 * The idempotency key itself: how a client mints one, and what the server will
 * accept.
 *
 * Separate from `@/lib/actions/idempotency` for one reason, and it is a hard
 * one rather than a stylistic one: that module hashes with `node:crypto`, so
 * importing it from a client component pulls a Node builtin into the browser
 * bundle. The key is generated in the browser — that is the whole point, since
 * a key the server invents cannot survive the retry it exists to deduplicate —
 * so the generator and the schema have to live somewhere a `"use client"` file
 * can reach. This module imports nothing.
 */
import { z } from "zod";

/**
 * The accepted length range.
 *
 * The floor is not cosmetic. A key is a promise that two requests carrying it
 * are the same request, and a short key is one that collides by accident inside
 * a single user's scope — at which point the second, *different* submission is
 * answered with the first one's result. 16 characters is comfortably below a
 * UUID (36) and far above anything a collision would reach.
 *
 * The ceiling is there because the column is indexed and the value comes from a
 * client, so it needs a bound that is not "whatever was posted".
 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 16;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * The schema an idempotent action folds into its own input schema.
 *
 * Deliberately not `z.uuid()`. `newIdempotencyKey` produces a UUID and callers
 * should use it, but the server's interest is only that the value is opaque,
 * bounded and unguessable-by-accident; a client that composes a key out of a
 * request id it already has is doing something reasonable, and rejecting it
 * would be the schema enforcing a format for its own sake.
 */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(
    IDEMPOTENCY_KEY_MIN_LENGTH,
    `An idempotency key must be at least ${IDEMPOTENCY_KEY_MIN_LENGTH} characters`,
  )
  .max(
    IDEMPOTENCY_KEY_MAX_LENGTH,
    `An idempotency key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
  );

/** Thrown when the environment offers no cryptographic randomness at all. */
export class NoRandomSourceError extends Error {
  constructor() {
    super(
      "No Web Crypto random source is available, so an idempotency key cannot be generated.",
    );
    this.name = "NoRandomSourceError";
  }
}

/**
 * A fresh key: one UUID v4.
 *
 * `crypto.randomUUID()` where it exists, and a `getRandomValues` fallback where
 * it does not — which is not defensive padding but a case this repository will
 * actually meet. `randomUUID` is restricted to secure contexts, so it is
 * `undefined` on plain `http://` over a LAN address: the shape of every "open
 * the dev server on my phone" and staging-behind-a-plain-proxy setup.
 * `getRandomValues` has no such restriction.
 *
 * Neither present throws, rather than falling back to `Math.random()`. The
 * threat is not that someone guesses a key — keys are scoped to one user, so a
 * guessed one reveals nothing — it is that two of a user's own submissions
 * *collide*, and the second is silently answered with the first one's result.
 * A generator with 32 bits of entropy makes that a real event; failing loudly
 * is the honest answer.
 */
export function newIdempotencyKey(): string {
  const source: Crypto | undefined =
    typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto;

  if (typeof source?.randomUUID === "function") {
    return source.randomUUID();
  }

  if (typeof source?.getRandomValues !== "function") {
    throw new NoRandomSourceError();
  }

  const bytes = source.getRandomValues(new Uint8Array(16));

  // RFC 9562 §5.4: version 4 in the high nibble of byte 6, variant 10xx in the
  // top two bits of byte 8. Read through `?? 0` because
  // `noUncheckedIndexedAccess` types an index into a `Uint8Array` as possibly
  // undefined; both indices are in range for a 16-byte array, so the fallback
  // is never taken.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));

  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}
