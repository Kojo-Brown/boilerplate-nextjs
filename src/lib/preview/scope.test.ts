import { describe, it, expect } from "vitest";
import { deriveHmacKey } from "@/lib/crypto/hmac";
import { serverEnv } from "@/lib/env/server";
import { toBase64Url } from "@/lib/preview/token";
import {
  PREVIEW_SCOPE_COOKIE,
  PREVIEW_SCOPE_COOKIE_ATTRIBUTES,
  signPreviewScope,
  verifyPreviewScope,
} from "./scope";

/**
 * Against the real Web Crypto implementation, like the token suite beside it and
 * for the same reason: a mocked HMAC would let every assertion here pass while
 * the module signed nothing, and "a cookie naming a workspace cannot be written
 * by anyone but this server" is the whole of what this file holds.
 *
 * The key derives from `NEXTAUTH_SECRET` (no `PREVIEW_SECRET` is set in the test
 * environment), which is the fallback path a default deployment takes.
 */

const TENANT = "tenant-mock-a";
const OTHER_TENANT = "tenant-mock-b";

/** The preview *token* key, which this module's values must not be verifiable by. */
function tokenKeyForTest(): Promise<CryptoKey> {
  return deriveHmacKey({
    secret: serverEnv.PREVIEW_SECRET ?? serverEnv.NEXTAUTH_SECRET,
    salt: "boilerplate-nextjs/preview-token/salt/v1",
    info: "boilerplate-nextjs/preview-token/v1",
  });
}

describe("signPreviewScope", () => {
  it("mints a value that verifies back to the same workspace", async () => {
    const value = await signPreviewScope(TENANT);

    expect(await verifyPreviewScope(value)).toEqual({ tenantId: TENANT });
  });

  it("is stable for one workspace, because a scope is not a nonce", async () => {
    // Deliberately unlike `signPreviewToken`, which randomises so that two links
    // for one post are distinguishable. There is nothing to tell apart here: the
    // cookie is state, two redemptions in the same workspace mean the same
    // thing, and a value that changed every time would make a test of the
    // redemption route assert a string it had to recompute.
    expect(await signPreviewScope(TENANT)).toBe(await signPreviewScope(TENANT));
  });

  it("puts the workspace in the value where a person can read it", async () => {
    // The format is `<tenantId>.<signature>` rather than an opaque blob, so that
    // "which workspace am I previewing" is answerable from devtools. It is not a
    // secret — it is a claim, and the signature is what makes it one.
    expect(await signPreviewScope(TENANT)).toMatch(
      new RegExp(`^${TENANT}\\.[A-Za-z0-9_-]+$`),
    );
  });

  it("refuses a workspace the database could not be scoped to", async () => {
    // The empty string is the dangerous one: `set_config` accepts it and
    // `app.preview_tenant_id()` maps it back to NULL, so a cookie carrying it
    // would verify and read the published site.
    await expect(signPreviewScope("")).rejects.toThrow(/non-empty tenantId/);
    await expect(signPreviewScope("has a space")).rejects.toThrow();
    await expect(signPreviewScope("line\nbreak")).rejects.toThrow();
    await expect(signPreviewScope("a".repeat(129))).rejects.toThrow();
  });
});

describe("verifyPreviewScope", () => {
  it("rejects a value whose workspace was swapped for another", async () => {
    // The attack the signature exists to stop, and the only one that matters
    // here: keep the signature, change which workspace the cookie claims.
    const value = await signPreviewScope(TENANT);
    const signature = value.slice(value.lastIndexOf(".") + 1);

    expect(await verifyPreviewScope(`${OTHER_TENANT}.${signature}`)).toBeNull();
  });

  it("rejects a value whose signature was edited", async () => {
    const value = await signPreviewScope(TENANT);
    const separator = value.lastIndexOf(".");
    const signature = value.slice(separator + 1);
    const flipped =
      signature[0] === "A"
        ? `B${signature.slice(1)}`
        : `A${signature.slice(1)}`;

    expect(
      await verifyPreviewScope(`${value.slice(0, separator)}.${flipped}`),
    ).toBeNull();
  });

  it("rejects a value signed with the preview token's key", async () => {
    // The domain separation, asserted rather than commented. Both signers fall
    // back to `NEXTAUTH_SECRET`, so the only thing keeping a token-signed string
    // from being a valid scope cookie is the HKDF `info` — and nothing else in
    // the codebase would fail if that stopped being true.
    const signature = await crypto.subtle.sign(
      "HMAC",
      await tokenKeyForTest(),
      new TextEncoder().encode(TENANT),
    );

    expect(
      await verifyPreviewScope(
        `${TENANT}.${toBase64Url(new Uint8Array(signature))}`,
      ),
    ).toBeNull();
  });

  it("rejects structurally broken input without throwing", async () => {
    for (const value of [
      "",
      ".",
      `${TENANT}.`,
      ".signature-only",
      "no-separator",
      `${TENANT}.not base64url!`,
      `has a space.${"A".repeat(43)}`,
      // An over-long tenant: refused on `assertScopeId` before any hashing, so
      // the bound is enforced on the way in rather than on the way out.
      `${"a".repeat(129)}.${"A".repeat(43)}`,
    ]) {
      expect(await verifyPreviewScope(value), value).toBeNull();
    }
  });

  it("splits on the last separator, not the first", async () => {
    // `assertScopeId` forbids a dot in a tenant id, so a value with two of them
    // is malformed either way — but splitting on the first would hand the
    // signature verifier a *truncated* signature and the tenant check a value
    // that passes, which is a longer path to the same answer through code that
    // did not expect to be there.
    expect(await verifyPreviewScope(`a.b.${"A".repeat(43)}`)).toBeNull();
  });
});

describe("the cookie", () => {
  it("is httpOnly, lax, and scoped to the whole site", async () => {
    // Shaped to match `__prerender_bypass`, the cookie it accompanies: the two
    // have to arrive and expire together, because a draft session with no scope
    // reads the published site and a scope with no session does nothing.
    expect(PREVIEW_SCOPE_COOKIE_ATTRIBUTES).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("is a session cookie, with no lifetime of its own", async () => {
    // Not an oversight. A draft session has never expired here — see the note on
    // `exp` in `@/lib/preview/token` — and giving the scope a lifetime the
    // session does not have would silently end previews that work today.
    expect(PREVIEW_SCOPE_COOKIE_ATTRIBUTES).not.toHaveProperty("maxAge");
    expect(PREVIEW_SCOPE_COOKIE_ATTRIBUTES).not.toHaveProperty("expires");
  });

  it("is not marked Secure in a deployment served over http", async () => {
    // `USE_SECURE_COOKIES` comes from the pinned origin's scheme, and the test
    // environment's `NEXTAUTH_URL` is `http://localhost:3000`. A `Secure` cookie
    // set over plain http is discarded by the browser without a word, which
    // would leave every local draft session permanently unscoped.
    expect(PREVIEW_SCOPE_COOKIE_ATTRIBUTES.secure).toBe(false);
  });

  it("has a name that does not collide with the framework's", async () => {
    expect(PREVIEW_SCOPE_COOKIE).not.toBe("__prerender_bypass");
    expect(PREVIEW_SCOPE_COOKIE).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
