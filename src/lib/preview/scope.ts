/**
 * The workspace a draft session is scoped to, as a signed cookie.
 *
 * ## Why a second cookie exists at all
 *
 * A preview token names a tenant, and the token is spent in one request: the
 * CMS's "Preview" button is followed, `/api/preview` verifies the signature and
 * redirects, and from then on the reader is in draft mode because of a cookie
 * Next owns. `draftMode()` is a boolean — `__prerender_bypass` carries the
 * framework's `previewModeId` and nothing of ours — so there is no room in it
 * for the one fact every subsequent read needs. Without somewhere to put that
 * fact, the tenant in the token would bound the *link* and not the *session*,
 * which is precisely the distinction the token module's note on `exp` is about.
 *
 * So the redemption writes it down, and this module is that format.
 *
 * ## The format, and why it is not JSON
 *
 * `<tenantId>.<base64url(HMAC-SHA256(tenantId))>`. The tenant id goes in as
 * itself rather than encoded: `assertScopeId` already confines it to
 * `[A-Za-z0-9_-]`, which is base64url's own alphabet and contains neither the
 * separator nor anything a `Set-Cookie` header would have to quote. The payload
 * is one field and will stay one field — anything else about a preview session
 * is either in the framework's cookie or is a per-request read — so a JSON
 * envelope would buy a parser, a `parsePayload` and a third failure mode for no
 * field. It also leaves the cookie legible in devtools, which for a value whose
 * whole job is "which workspace am I previewing" is worth having.
 *
 * The signature is over the tenant id alone and that is deliberate rather than
 * minimal: what has to be unforgeable is the *claim*, and the claim is one
 * string. There is no expiry in it because a draft session has never had one
 * here (see the token module), and writing one in would silently end sessions
 * that work today — a change worth making on purpose, as its own item, not as a
 * side effect of scoping them.
 *
 * ## Domain separation
 *
 * Its own HKDF `info`, so this key is unrelated to the preview *token* key even
 * though both descend from the same secret. That is not housekeeping: without
 * it, a one-field cookie signed by the token key would be — modulo encoding —
 * a thing an attacker could try to obtain from the token signer, and the two
 * verifiers would accept each other's output. `@/lib/crypto/hmac` has the
 * general argument.
 *
 * ## Runtime
 *
 * Web Crypto and `TextEncoder` only, like the token module beside it, because
 * `/api/preview` writes this cookie and declares `portable: true` in
 * `@/lib/api/runtimes`.
 */
// Mints and verifies a capability with the preview signing key. See
// docs/server-only.md.
import "server-only";

import { deriveHmacKey } from "@/lib/crypto/hmac";
import { serverEnv } from "@/lib/env/server";
import { fromBase64Url, toBase64Url } from "@/lib/preview/token";
import { assertScopeId, InvalidTenantScopeError } from "@/lib/tenancy/scope";
import { USE_SECURE_COOKIES } from "@/lib/auth/deployment";

/**
 * The cookie's name.
 *
 * No `__Host-` prefix, unlike the session cookie, and the reason is stated
 * rather than left as an omission. The prefix stops anything that can write
 * cookies for a sibling name from setting this one — but the value here is
 * signed, so such a writer cannot produce one this server accepts, and the only
 * cookie it could transplant is a valid scope for a workspace whose drafts it
 * already holds. Set against that: a prefix on the companion and none on
 * `__prerender_bypass`, which is the cookie that actually turns draft mode on,
 * would be protection in the wrong place.
 */
export const PREVIEW_SCOPE_COOKIE = "preview-tenant";

/** The workspace a draft session may read. */
export interface PreviewScope {
  readonly tenantId: string;
}

/**
 * Domain separation for the derived key. Changing it invalidates every live
 * preview session, which is a cheap thing to invalidate.
 */
const HKDF_INFO = "boilerplate-nextjs/preview-scope/v1";
const HKDF_SALT = "boilerplate-nextjs/preview-scope/salt/v1";

const encoder = new TextEncoder();

/** Signs `tenantId` into a cookie value. Throws on a tenant id we could not scope to. */
export async function signPreviewScope(tenantId: string): Promise<string> {
  assertScopeId(tenantId, "tenantId");

  const signature = await crypto.subtle.sign(
    "HMAC",
    await scopeKey(),
    encoder.encode(tenantId),
  );

  return `${tenantId}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Reads a cookie value back, or `null`.
 *
 * One `null` for every way of failing, and no reason codes. The token route
 * distinguishes "expired" from "forged" because it answers a person who
 * followed a link and can be told to ask for a new one; nothing reads this
 * value except the blog's own data layer, which has exactly one thing to do
 * with a bad cookie — serve the published site — and no channel to say more.
 *
 * The verification is `crypto.subtle.verify` over the tenant id, so a cookie
 * whose tenant was edited fails on the signature rather than on the shape:
 * `assertScopeId` runs first only to keep an absurd value out of the hashing
 * path, and passing it proves nothing.
 */
export async function verifyPreviewScope(
  value: string,
): Promise<PreviewScope | null> {
  const separator = value.lastIndexOf(".");
  if (separator <= 0 || separator === value.length - 1) return null;

  const tenantId = value.slice(0, separator);
  const encodedSignature = value.slice(separator + 1);

  try {
    assertScopeId(tenantId, "tenantId");
  } catch (thrown) {
    if (thrown instanceof InvalidTenantScopeError) return null;
    throw thrown;
  }

  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = fromBase64Url(encodedSignature);
  } catch {
    return null;
  }

  const matches = await crypto.subtle.verify(
    "HMAC",
    await scopeKey(),
    signature,
    encoder.encode(tenantId),
  );

  return matches ? { tenantId } : null;
}

/**
 * The attributes the cookie is written with.
 *
 * Shaped to match `__prerender_bypass`, the cookie it accompanies, because the
 * failure mode of the two disagreeing is a reader in draft mode whose session
 * has no scope. `httpOnly` — nothing in the browser reads it, and an XSS must
 * not be able to point a preview at another workspace. `sameSite: "lax"` —
 * redemption is a top-level cross-site GET arriving from a CMS, which `strict`
 * would strip. No `maxAge` and no `expires`, so it is a session cookie that
 * dies with the browser, exactly as the bypass cookie does: a scope that
 * outlived the draft session it scopes would be a stale capability sitting in a
 * jar, and one that died first would leave the session unscoped.
 *
 * `secure` comes from `@/lib/auth/deployment`, which derives it from the pinned
 * origin's scheme rather than from `NODE_ENV` — a `Secure` cookie set over
 * `http://localhost` is discarded by the browser without a word, and the
 * resulting draft session would be permanently unscoped with nothing to read in
 * any log.
 */
export const PREVIEW_SCOPE_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: USE_SECURE_COOKIES,
} as const;

let cachedKey: Promise<CryptoKey> | undefined;

function scopeKey(): Promise<CryptoKey> {
  cachedKey ??= deriveHmacKey({
    // The same secret as the token signer, through a different `info`. See
    // `@/lib/crypto/hmac` for why falling back to `NEXTAUTH_SECRET` is safe
    // only because of that.
    secret: serverEnv.PREVIEW_SECRET ?? serverEnv.NEXTAUTH_SECRET,
    salt: HKDF_SALT,
    info: HKDF_INFO,
  });
  return cachedKey;
}
