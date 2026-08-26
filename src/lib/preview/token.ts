/**
 * Signed preview tokens — the capability that buys a draft-mode session.
 *
 * ## What a token is
 *
 * `base64url(payload).base64url(HMAC-SHA256(payload))`, where the payload names
 * the one path the token authorises, when it stops working, and a nonce. It is
 * a bearer capability: whoever holds it may read that path as a draft, and
 * nothing else about them is checked at redemption time. Authorisation happens
 * once, at *minting* — `createPreviewLinkAction` requires a session and post
 * ownership — which is what makes redemption cheap enough to hand to an
 * external CMS's preview button.
 *
 * ## Why the path is inside the signature
 *
 * Next's own draft-mode guide redirects to a path taken from the query string:
 *
 *     const slug = searchParams.get('slug')
 *     …
 *     redirect(`/posts/${slug}`)
 *
 * The secret authorises *entering draft mode*, and the destination is whatever
 * the caller appended — so one leaked preview link is a redirect oracle for the
 * whole origin, and every link is interchangeable with every other. Signing the
 * path removes both properties: the destination is an output of verification
 * rather than an input to it, and a link minted for one post cannot be pointed
 * at another. `isSafePreviewPath` is still applied on both sides, because
 * "signed by us" and "safe to redirect to" are different claims and this module
 * should not be the only thing standing between a mistake in one and the other.
 *
 * ## What `exp` does and does not bound
 *
 * It bounds the *link*. It does not bound the session the link opens: draft
 * mode is a cookie Next writes and only Next's own `previewModeId` invalidates,
 * so an expired token cannot retroactively close a preview that is already
 * open. `docs/draft-mode.md` covers what does close one. The expiry is still
 * worth having — a preview URL forwarded in an email is the realistic leak, and
 * a fifteen-minute window is the difference between a stale link and a
 * permanent one.
 *
 * ## Runtime
 *
 * Web Crypto and `TextEncoder` only — no `node:crypto`, no `Buffer`. This is
 * what lets `/api/preview` declare `portable: true` in `@/lib/api/runtimes`, a
 * claim `scripts/assert-api-runtimes.ts` checks against the build's dependency
 * trace on every CI run.
 */
import { deriveHmacKey } from "@/lib/crypto/hmac";
import { env } from "@/lib/env";

/**
 * How long a freshly minted link stays redeemable.
 *
 * Fifteen minutes is a click-through window, not a working session: the token
 * is spent the moment the CMS's "Preview" button is followed, and the draft
 * session it opens outlives it. Long enough to survive a slow deploy or a
 * distracted author, short enough that a link pasted into a ticket is dead by
 * the time anyone else reads it.
 */
export const PREVIEW_TOKEN_TTL_SECONDS = 15 * 60;

/** The route that redeems a token. */
export const PREVIEW_ENTER_PATH = "/api/preview";

/**
 * Domain separation for the derived key.
 *
 * The signing key is derived rather than used directly so that
 * `NEXTAUTH_SECRET` can serve as the fallback input without the preview signer
 * and the session signer ever holding the same bytes. HKDF with a fixed `info`
 * makes "the preview key" a different key from "the auth key" even when both
 * descend from one secret, which is the property that stops a token minted for
 * one purpose from being verifiable by the other.
 */
const HKDF_INFO = "boilerplate-nextjs/preview-token/v1";

/**
 * HKDF's salt is optional and public; a fixed non-empty value is preferred to
 * an empty one purely because it pins this derivation to this application.
 */
const HKDF_SALT = "boilerplate-nextjs/preview-token/salt/v1";

export interface PreviewTokenPayload {
  /** The application path this token authorises a preview of. */
  path: string;
  /** Expiry, as whole unix seconds. */
  exp: number;
  /**
   * 16 random bytes, base64url.
   *
   * Two links minted for the same path in the same second would otherwise be
   * byte-identical, which makes a token useless as a thing to log, revoke or
   * tell apart in a support conversation.
   */
  nonce: string;
}

/**
 * Why a token was rejected.
 *
 * Separate reasons rather than a bare `false`, because the route answers
 * "expired" differently from "forged" — a reader who followed a stale link
 * needs to be told to ask for a new one, and a reader whose token does not
 * verify needs to be told nothing at all.
 */
export type PreviewTokenFailure =
  "malformed" | "bad-signature" | "expired" | "unsafe-path";

export type PreviewTokenVerification =
  | { valid: true; payload: PreviewTokenPayload }
  | { valid: false; reason: PreviewTokenFailure };

export interface SignPreviewTokenOptions {
  /** Overrides {@link PREVIEW_TOKEN_TTL_SECONDS}. Must be positive. */
  ttlSeconds?: number;
  /** The clock. Injected so tests can mint an already-expired token. */
  now?: Date;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Whether a path is one this application will redirect a browser to.
 *
 * Site-relative only. The three rejected shapes are the ones that turn a
 * redirect into an off-origin one:
 *
 *   `//evil.example`  a protocol-relative URL — a valid absolute URL to a
 *                     browser, and it starts with `/`, which is why a bare
 *                     `startsWith("/")` check is not enough.
 *   `/\evil.example`  the same trick with a backslash, which several browsers
 *                     normalise to `/`.
 *   `https://…`       an absolute URL outright.
 *
 * Applied when minting *and* when redeeming. Minting is where a bad path can
 * still be rejected loudly; redeeming is where it would do damage.
 */
export function isSafePreviewPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//") || path.startsWith("/\\")) return false;
  // A control character in a `Location` header is a response-splitting
  // vector, a newline most of all. None has any business in a path this
  // application minted.
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return true;
}

/** Mints a token for `path`. Throws if the path is not one we would redirect to. */
export async function signPreviewToken(
  path: string,
  options: SignPreviewTokenOptions = {},
): Promise<string> {
  if (!isSafePreviewPath(path)) {
    throw new Error(`Refusing to sign a preview token for path "${path}".`);
  }

  const ttlSeconds = options.ttlSeconds ?? PREVIEW_TOKEN_TTL_SECONDS;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`Preview token TTL must be positive, got ${ttlSeconds}.`);
  }

  const issuedAt = options.now ?? new Date();
  const payload: PreviewTokenPayload = {
    path,
    exp: Math.floor(issuedAt.getTime() / 1000) + Math.floor(ttlSeconds),
    nonce: randomNonce(),
  };

  const encodedPayload = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await previewKey(),
    encoder.encode(encodedPayload),
  );

  return `${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Verifies a token and returns its payload.
 *
 * The order matters: signature before expiry, and structure before signature.
 * Reading `exp` off an unverified payload and answering "expired" would hand a
 * forger a way to learn that their forgery parsed, and would let an attacker
 * who can edit the payload set `exp` to whatever they like — the field is only
 * meaningful once the bytes carrying it are known to be ours.
 *
 * `crypto.subtle.verify` rather than a re-sign and a string compare: the Web
 * Crypto spec requires the comparison to be constant-time, and a hand-rolled
 * one in this position is a timing oracle waiting for someone to simplify it.
 */
export async function verifyPreviewToken(
  token: string,
  options: { now?: Date } = {},
): Promise<PreviewTokenVerification> {
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) {
    return { valid: false, reason: "malformed" };
  }

  const encodedPayload = token.slice(0, separator);
  const encodedSignature = token.slice(separator + 1);

  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = fromBase64Url(encodedSignature);
  } catch {
    return { valid: false, reason: "malformed" };
  }

  const signatureMatches = await crypto.subtle.verify(
    "HMAC",
    await previewKey(),
    signature,
    encoder.encode(encodedPayload),
  );
  if (!signatureMatches) return { valid: false, reason: "bad-signature" };

  // Everything from here on is our own bytes, so a parse failure is a bug in
  // this module rather than an attack — but it is still answered rather than
  // thrown, because a key rotation that happens to produce a colliding
  // signature is not a reason to 500.
  let payload: PreviewTokenPayload;
  try {
    payload = parsePayload(decoder.decode(fromBase64Url(encodedPayload)));
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (!isSafePreviewPath(payload.path)) {
    return { valid: false, reason: "unsafe-path" };
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (payload.exp <= nowSeconds) return { valid: false, reason: "expired" };

  return { valid: true, payload };
}

/**
 * The absolute URL that opens a preview of `path`.
 *
 * Absolute because the realistic consumer is an external CMS rendering a
 * "Preview" button, which has no origin of ours to resolve a relative URL
 * against. `NEXT_PUBLIC_APP_URL` is the same origin the rest of the application
 * advertises itself on.
 */
export async function createPreviewLink(
  path: string,
  options: SignPreviewTokenOptions = {},
): Promise<{ url: string; expiresAt: Date }> {
  const token = await signPreviewToken(path, options);
  const url = new URL(PREVIEW_ENTER_PATH, env.NEXT_PUBLIC_APP_URL);
  url.searchParams.set("token", token);

  const ttlSeconds = options.ttlSeconds ?? PREVIEW_TOKEN_TTL_SECONDS;
  const issuedAt = options.now ?? new Date();

  return {
    url: url.toString(),
    expiresAt: new Date(issuedAt.getTime() + Math.floor(ttlSeconds) * 1000),
  };
}

/**
 * Validates the decoded payload rather than trusting its shape.
 *
 * Zod would do this in three lines, and is deliberately not used: this module
 * is the reason `/api/preview` can claim `portable: true`, and every import it
 * grows is a package in that route's dependency trace. The shape is four
 * fields and does not move.
 */
function parsePayload(json: string): PreviewTokenPayload {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null) {
    throw new Error("Preview token payload is not an object.");
  }

  const { path, exp, nonce } = value as Record<string, unknown>;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Preview token payload has no path.");
  }
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    throw new Error("Preview token payload has no expiry.");
  }
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new Error("Preview token payload has no nonce.");
  }

  return { path, exp, nonce };
}

/**
 * The HMAC key, derived once per process.
 *
 * Memoised on the promise rather than the key so that concurrent first calls
 * share one derivation instead of racing to do it twice. `CryptoKey` is created
 * non-extractable, so the raw bytes cannot be read back out of it by anything
 * that gets hold of the reference.
 */
let cachedKey: Promise<CryptoKey> | undefined;

function previewKey(): Promise<CryptoKey> {
  cachedKey ??= deriveKey();
  return cachedKey;
}

function deriveKey(): Promise<CryptoKey> {
  // `PREVIEW_SECRET` is optional on purpose. Requiring it would add a second
  // mandatory secret to every deployment of this boilerplate to enable a
  // feature most of them will not use, and the usual result of that is a
  // committed placeholder. Falling back to `NEXTAUTH_SECRET` *through HKDF*
  // costs nothing, reuses no key material, and gives rotation the behaviour
  // you would want anyway: rotating the auth secret invalidates outstanding
  // preview links. Setting `PREVIEW_SECRET` decouples the two for teams that
  // want preview links to survive an auth-secret rotation, or want the preview
  // signer handed to a CMS without handing over the session signer.
  //
  // The derivation itself lives in `@/lib/crypto/hmac`, shared with the
  // revalidation webhook's signer. `HKDF_INFO` is what keeps the two keys
  // unrelated despite the shared fallback secret — see the note there.
  return deriveHmacKey({
    secret: env.PREVIEW_SECRET ?? env.NEXTAUTH_SECRET,
    salt: HKDF_SALT,
    info: HKDF_INFO,
  });
}

function randomNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * base64url, unpadded — RFC 4648 §5.
 *
 * `btoa`/`atob` rather than `Buffer`: both are global in Node 18+ and in the
 * edge runtime, and `Buffer` is not. They speak latin-1, so the input is
 * chunked through `String.fromCharCode` rather than spread in one call, which
 * blows the argument limit on inputs a preview payload will never reach but a
 * future caller might.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * Throws on anything `toBase64Url` could not have produced.
 *
 * The return type is `Uint8Array<ArrayBuffer>` rather than the default
 * `Uint8Array<ArrayBufferLike>` because `crypto.subtle.verify` takes a
 * `BufferSource`, and a `SharedArrayBuffer`-backed view is not one. Allocating
 * the `ArrayBuffer` explicitly is what makes that true by construction — the
 * alternative is a cast asserting something this function can simply be.
 */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Not base64url.");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
