/**
 * The signature scheme for inbound webhooks.
 *
 * `POST /api/revalidate` drops cache entries for anyone who can call it, so it
 * needs an authenticator. It cannot be the session: the caller is a CMS's
 * outgoing-webhook worker, which has no browser, no cookie jar and no way to
 * complete an OAuth flow. It is a shared secret, applied the way every CMS
 * already applies one.
 *
 * ## The header
 *
 *     x-revalidate-signature: t=1774483200,v1=9f86d0818884…
 *
 * `t` is the unix second the request was signed; `v1` is
 * `HMAC-SHA256(key, "<t>.<raw body>")` in lowercase hex. The scheme is
 * Stripe's, and the borrowing is deliberate — it is the shape a CMS integration
 * engineer already knows how to produce, and every property below is a property
 * of *that* shape rather than something invented here.
 *
 * ## Three decisions that are the whole point
 *
 * **1. The signature covers the raw bytes, not the parsed object.** This is why
 * `/api/revalidate` reads `await request.text()` and parses the JSON itself
 * rather than going through `defineRoute`'s `body` schema. Verifying against
 * `JSON.stringify(parsedBody)` looks equivalent and is not: key order, unicode
 * escaping, number formatting and whitespace all survive the sender's
 * serialiser and none survive a round trip through ours. A re-serialising
 * verifier rejects valid requests from some senders and — worse — is a verifier
 * whose input is not the thing that was signed, so a payload that parses to the
 * same object as the signed one is accepted whatever bytes it actually carried.
 *
 * **2. The timestamp is inside the signed material, not beside it.** A `t` sent
 * as a plain header would be an attacker-controlled input to the freshness
 * check: capture a valid request, rewrite `t` to now, replay forever. Signing
 * `"<t>.<body>"` means a `t` that has been touched no longer verifies, so the
 * freshness check is made against a value the sender committed to.
 *
 * **3. The comparison is `crypto.subtle.verify`.** The Web Crypto spec requires
 * it to be constant-time. A re-sign plus `===` is the same computation with a
 * timing oracle attached, and it is the form someone reaches for when
 * simplifying this file.
 *
 * ## What the tolerance window does and does not buy
 *
 * It bounds replay: a captured request stops being usable
 * {@link SIGNATURE_TOLERANCE_SECONDS} after it was signed. It does **not** make
 * delivery exactly-once — inside the window the same bytes can be replayed as
 * often as the attacker likes.
 *
 * That is an accepted limitation rather than an oversight, and the reasoning is
 * worth writing down: closing it needs a store of spent signatures shared by
 * every instance, which this application does not have and which a boilerplate
 * should not invent (a `Map` in module scope is per-instance, so it would
 * "work" on one server and silently do nothing behind a load balancer). It is
 * also a small hole for *this* endpoint, whose entire authority is to drop
 * cache entries: a replayed revalidation costs a cache fill. An endpoint that
 * wrote data would need the store. `docs/on-demand-revalidation.md` says so.
 *
 * ## Runtime
 *
 * Web Crypto only, so `/api/revalidate` can declare `portable: true` in
 * `@/lib/api/runtimes`.
 */
import { deriveHmacKey, fromHex, toHex } from "@/lib/crypto/hmac";
import { env } from "@/lib/env";

/** The header a signed request carries. Lowercase — header names are case-insensitive, lookups here are not. */
export const SIGNATURE_HEADER = "x-revalidate-signature";

/**
 * How far a signature's timestamp may be from now, in either direction.
 *
 * Five minutes is the interval Stripe, GitHub and most CMS webhook senders
 * assume, and it is chosen for retries and clock skew rather than for
 * transport: a sender whose delivery worker is backed up may sign a payload
 * minutes before it reaches the network, and a sender whose clock is a minute
 * fast must not be rejected outright.
 *
 * Applied symmetrically. A future-dated signature is as suspect as a stale one
 * — accepting one unboundedly would let a sender (or anyone who compromised the
 * secret once) mint a request that stays valid indefinitely.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/**
 * Domain separation for the webhook key. Changing it invalidates every
 * signature made under the old value — see `@/lib/crypto/hmac`.
 */
const HKDF_INFO = "boilerplate-nextjs/revalidate-webhook/v1";

/** Public, fixed, and distinct from the preview signer's for the same reason. */
const HKDF_SALT = "boilerplate-nextjs/revalidate-webhook/salt/v1";

/** The version prefix in the header. Present so a v2 scheme can be added without ambiguity. */
const SIGNATURE_VERSION = "v1";

/**
 * Why a request was rejected.
 *
 * Separate reasons rather than a bare `false` because the route answers one of
 * them differently: a timestamp outside the window is the failure an operator
 * integrating a CMS will actually hit, and "your clock is wrong" is the only
 * useful thing to say to them. It leaks nothing — the timestamp is in the
 * request the caller just sent. The other three are answered identically, since
 * telling them apart only helps someone probing the endpoint.
 */
export type SignatureFailure =
  "missing" | "malformed" | "bad-signature" | "outside-tolerance";

export type SignatureVerification =
  { valid: true; signedAt: Date } | { valid: false; reason: SignatureFailure };

export interface SignOptions {
  /** The clock. Injected so tests can produce a stale or future-dated signature. */
  now?: Date;
}

export interface VerifyOptions {
  /** The clock. Injected so tests can verify against a fixed instant. */
  now?: Date;
  /** Overrides {@link SIGNATURE_TOLERANCE_SECONDS}. */
  toleranceSeconds?: number;
}

const encoder = new TextEncoder();

/**
 * Produces the header value for a raw body.
 *
 * Exported rather than kept private to the tests: it is what
 * `docs/on-demand-revalidation.md` points a CMS integrator at, and it is the
 * only way to write a test that proves the verifier accepts what a correct
 * sender produces without hardcoding a hex string that would have to be
 * regenerated whenever the secret changed.
 */
export async function signWebhookPayload(
  body: string,
  options: SignOptions = {},
): Promise<string> {
  const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await webhookKey(),
    encoder.encode(signedMaterial(timestamp, body)),
  );

  return `t=${timestamp},${SIGNATURE_VERSION}=${toHex(new Uint8Array(signature))}`;
}

/**
 * Verifies a header against the raw body it should cover.
 *
 * The order is structure, then signature, then freshness — the same order and
 * for the same reason as `verifyPreviewToken`: `t` is only meaningful once the
 * bytes carrying it are known to be ours, so checking the window first would
 * hand a forger a way to learn that their forgery parsed.
 */
export async function verifyWebhookSignature(
  header: string | null | undefined,
  body: string,
  options: VerifyOptions = {},
): Promise<SignatureVerification> {
  if (!header) return { valid: false, reason: "missing" };

  const parsed = parseHeader(header);
  if (!parsed) return { valid: false, reason: "malformed" };

  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = fromHex(parsed.signature);
  } catch {
    return { valid: false, reason: "malformed" };
  }

  const signatureMatches = await crypto.subtle.verify(
    "HMAC",
    await webhookKey(),
    signature,
    encoder.encode(signedMaterial(parsed.timestamp, body)),
  );
  if (!signatureMatches) return { valid: false, reason: "bad-signature" };

  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    return { valid: false, reason: "outside-tolerance" };
  }

  return { valid: true, signedAt: new Date(parsed.timestamp * 1000) };
}

/**
 * What the HMAC covers.
 *
 * The separator matters: without one, `t=1` over body `"23…"` and `t=12` over
 * body `"3…"` produce identical material, so a signature made for one is valid
 * for the other. A `.` cannot appear in the decimal timestamp, which is what
 * makes the split unambiguous.
 */
function signedMaterial(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

interface ParsedHeader {
  timestamp: number;
  signature: string;
}

/**
 * Reads `t=…,v1=…` into its two fields.
 *
 * Order-insensitive and tolerant of extra `k=v` pairs, because a sender that
 * adds a `v2=` alongside `v1=` during a scheme rollover is doing the correct
 * thing and must not be rejected by this parser. Anything that is not a `k=v`
 * pair, and any `t` that is not whole seconds, is malformed — `Number.parseInt`
 * is deliberately not used, since it would read `t=17e9` and `t=12abc` as
 * numbers.
 */
function parseHeader(header: string): ParsedHeader | null {
  const fields = new Map<string, string>();

  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) return null;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key.length === 0 || value.length === 0) return null;
    // First occurrence wins, so a duplicated key cannot be used to smuggle a
    // second value past a verifier that reads the other one.
    if (!fields.has(key)) fields.set(key, value);
  }

  const rawTimestamp = fields.get("t");
  const signature = fields.get(SIGNATURE_VERSION);
  if (rawTimestamp === undefined || signature === undefined) return null;
  if (!/^\d+$/.test(rawTimestamp)) return null;

  const timestamp = Number(rawTimestamp);
  if (!Number.isSafeInteger(timestamp)) return null;

  return { timestamp, signature };
}

/**
 * The HMAC key, derived once per process.
 *
 * Memoised on the promise rather than the key so that concurrent first calls
 * share one derivation instead of racing to do it twice.
 */
let cachedKey: Promise<CryptoKey> | undefined;

function webhookKey(): Promise<CryptoKey> {
  // `REVALIDATE_SECRET` is optional for the same reason `PREVIEW_SECRET` is:
  // this endpoint is inert until a CMS is pointed at it, and demanding a second
  // mandatory secret from every deployment is how placeholder secrets get
  // committed. The fallback shares no key material with the session signer or
  // the preview signer — HKDF's `info` is what separates them.
  cachedKey ??= deriveHmacKey({
    secret: env.REVALIDATE_SECRET ?? env.NEXTAUTH_SECRET,
    salt: HKDF_SALT,
    info: HKDF_INFO,
  });
  return cachedKey;
}
