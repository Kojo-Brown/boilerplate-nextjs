import { describe, it, expect } from "vitest";
import { deriveHmacKey } from "@/lib/crypto/hmac";
import { serverEnv } from "@/lib/env/server";
import {
  PREVIEW_ENTER_PATH,
  PREVIEW_TOKEN_TTL_SECONDS,
  createPreviewLink,
  fromBase64Url,
  signPreviewToken,
  toBase64Url,
  verifyPreviewToken,
} from "./token";

/**
 * These run against the real Web Crypto implementation, not a mock.
 *
 * A mocked HMAC would let every assertion below pass while the module signed
 * nothing — and "the signature is checked" is the entire security property this
 * file exists to hold. `crypto.subtle` is available unmocked in both Vitest
 * projects, so there is no reason to accept a weaker test.
 *
 * The key derives from `NEXTAUTH_SECRET` (no `PREVIEW_SECRET` is set in the
 * test env), which is the fallback path a default deployment takes.
 */

const NOW = new Date("2026-08-23T12:00:00.000Z");

/** The workspace every token below is minted in. Obviously fake, like every fixture here. */
const TENANT = "tenant-mock-a";

/** `signPreviewToken` for a path, in the one workspace these tests care about. */
function sign(
  path: string,
  options: Parameters<typeof signPreviewToken>[1] = {},
): Promise<string> {
  return signPreviewToken({ path, tenantId: TENANT }, options);
}

/** Rewrites a token's payload while keeping the original signature. */
function withPayload(token: string, payload: unknown): string {
  const signature = token.slice(token.indexOf(".") + 1);
  const encoded = toBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return `${encoded}.${signature}`;
}

/**
 * The signing key, re-derived here.
 *
 * Two tests need to produce a *validly signed* payload the module itself can no
 * longer mint — a token with no tenant, and one with an empty tenant. The
 * alternative is exporting the key from the module, which would mean widening a
 * security primitive's surface for a test; re-deriving from the same public
 * inputs costs four lines and leaves the module alone. The strings are copied
 * from it on purpose: if either changes, these two tests fail, which is the
 * right outcome for a change that invalidates every outstanding link.
 */
function previewKeyForTest(): Promise<CryptoKey> {
  return deriveHmacKey({
    // Through `serverEnv`, not `process.env`: the `no-secret-env-access` lint
    // rule covers test files under `src/` on purpose, because a test that reads
    // a secret out of the environment is reading the machine it happens to run
    // on. This is the same expression the module uses.
    secret: serverEnv.PREVIEW_SECRET ?? serverEnv.NEXTAUTH_SECRET,
    salt: "boilerplate-nextjs/preview-token/salt/v1",
    info: "boilerplate-nextjs/preview-token/v1",
  });
}

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(256).map((_, index) => index);
    expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
  });

  it("emits no padding and no characters that need URL-escaping", () => {
    // One, two and three trailing bytes cover all three padding cases.
    for (const length of [1, 2, 3, 4]) {
      const encoded = toBase64Url(new Uint8Array(length).fill(0xff));
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("rejects input it could not have produced", () => {
    expect(() => fromBase64Url("not base64")).toThrow();
    expect(() => fromBase64Url("has+plus")).toThrow();
    expect(() => fromBase64Url("has/slash")).toThrow();
  });
});

describe("signPreviewToken", () => {
  it("mints a token that verifies", async () => {
    const token = await sign("/blog/abc123", { now: NOW });
    const result = await verifyPreviewToken(token, { now: NOW });

    expect(result).toEqual({
      valid: true,
      payload: {
        path: "/blog/abc123",
        tenantId: TENANT,
        exp: Math.floor(NOW.getTime() / 1000) + PREVIEW_TOKEN_TTL_SECONDS,
        nonce: expect.any(String),
      },
    });
  });

  it("mints a different token every time for the same path and second", async () => {
    const [first, second] = await Promise.all([
      sign("/blog/abc123", { now: NOW }),
      sign("/blog/abc123", { now: NOW }),
    ]);

    expect(first).not.toBe(second);
  });

  it("refuses to sign a path it would not redirect to", async () => {
    await expect(sign("//evil.example")).rejects.toThrow(/Refusing to sign/);
    await expect(sign("https://evil.example/blog")).rejects.toThrow();
  });

  it("refuses a tenant the database could not be scoped to", async () => {
    // The empty string is the dangerous one, and not because it throws: it is a
    // successful `set_config`, and `app.preview_tenant_id()` maps it back to
    // NULL — so a token carrying it would verify, open a draft session, and
    // show the published site. Refusing at the signer keeps that out of a
    // *signed* payload, where nothing downstream can tell it from a real one.
    await expect(
      signPreviewToken({ path: "/blog/abc123", tenantId: "" }),
    ).rejects.toThrow(/non-empty tenantId/);
    await expect(
      signPreviewToken({ path: "/blog/abc123", tenantId: "has a space" }),
    ).rejects.toThrow();
    await expect(
      signPreviewToken({ path: "/blog/abc123", tenantId: "line\nbreak" }),
    ).rejects.toThrow();
  });

  it("refuses a non-positive TTL rather than minting a dead token", async () => {
    await expect(sign("/blog", { ttlSeconds: 0 })).rejects.toThrow(
      /must be positive/,
    );
    await expect(sign("/blog", { ttlSeconds: -60 })).rejects.toThrow(
      /must be positive/,
    );
  });
});

describe("verifyPreviewToken", () => {
  it("rejects a token whose payload was edited", async () => {
    const token = await sign("/blog/mine", { now: NOW });
    const tampered = withPayload(token, {
      path: "/blog/not-mine",
      tenantId: TENANT,
      exp: Math.floor(NOW.getTime() / 1000) + 600,
      nonce: "x",
    });

    expect(await verifyPreviewToken(tampered, { now: NOW })).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("rejects an expiry pushed into the future by hand", async () => {
    // The attack the signature exists to stop: take a real token, extend its
    // life, keep the signature. It must not come back as valid *or* as
    // "expired" — the payload is not ours any more, so nothing in it counts.
    const token = await sign("/blog/mine", {
      now: NOW,
      ttlSeconds: 60,
    });
    const extended = withPayload(token, {
      path: "/blog/mine",
      tenantId: TENANT,
      exp: Math.floor(NOW.getTime() / 1000) + 86_400,
      nonce: "x",
    });

    expect(await verifyPreviewToken(extended, { now: NOW })).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("rejects a token signed with a different key", async () => {
    // Byte-swapping the signature is the closest a test with one key can get to
    // a forgery, and it exercises the same comparison.
    const token = await sign("/blog/abc123", { now: NOW });
    const [payload, signature] = token.split(".") as [string, string];
    const flipped =
      signature[0] === "A"
        ? `B${signature.slice(1)}`
        : `A${signature.slice(1)}`;

    expect(await verifyPreviewToken(`${payload}.${flipped}`)).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("rejects a token that has expired", async () => {
    const token = await sign("/blog/abc123", {
      now: NOW,
      ttlSeconds: 60,
    });

    const oneSecondLate = new Date(NOW.getTime() + 61_000);
    expect(await verifyPreviewToken(token, { now: oneSecondLate })).toEqual({
      valid: false,
      reason: "expired",
    });
  });

  it("treats the expiry second itself as expired", async () => {
    const token = await sign("/blog/abc123", {
      now: NOW,
      ttlSeconds: 60,
    });

    expect(
      await verifyPreviewToken(token, {
        now: new Date(NOW.getTime() + 60_000),
      }),
    ).toEqual({ valid: false, reason: "expired" });
  });

  it("still accepts a token one second before it expires", async () => {
    const token = await sign("/blog/abc123", {
      now: NOW,
      ttlSeconds: 60,
    });

    const result = await verifyPreviewToken(token, {
      now: new Date(NOW.getTime() + 59_000),
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a token whose tenant was swapped for another workspace's", async () => {
    // The whole point of signing the tenant. A holder who could edit this field
    // would hold a reader for every workspace in the deployment, which is worse
    // than the gap putting it in the payload closed.
    const token = await sign("/blog/mine", { now: NOW });
    const repointed = withPayload(token, {
      path: "/blog/mine",
      tenantId: "tenant-mock-b",
      exp: Math.floor(NOW.getTime() / 1000) + 600,
      nonce: "x",
    });

    expect(await verifyPreviewToken(repointed, { now: NOW })).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("rejects a payload with no tenant, which is what a pre-upgrade token is", async () => {
    // Not a forgery: a link minted by the release before the tenant existed in
    // the payload. It is answered as `malformed` — the same 401 as a forgery —
    // because the alternative is honouring a token that names no workspace, and
    // "no workspace" used to mean all of them. Hand-signed here, since this
    // module can no longer produce one.
    const payload = toBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          path: "/blog/mine",
          exp: Math.floor(NOW.getTime() / 1000) + 600,
          nonce: "x",
        }),
      ),
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      await previewKeyForTest(),
      new TextEncoder().encode(payload),
    );

    expect(
      await verifyPreviewToken(
        `${payload}.${toBase64Url(new Uint8Array(signature))}`,
        { now: NOW },
      ),
    ).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects a signed payload whose tenant is the empty string", async () => {
    // The same shape as above and the more interesting half: a legitimately
    // signed token that would open a draft session with no readable workspace.
    const payload = toBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          path: "/blog/mine",
          tenantId: "",
          exp: Math.floor(NOW.getTime() / 1000) + 600,
          nonce: "x",
        }),
      ),
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      await previewKeyForTest(),
      new TextEncoder().encode(payload),
    );

    expect(
      await verifyPreviewToken(
        `${payload}.${toBase64Url(new Uint8Array(signature))}`,
        { now: NOW },
      ),
    ).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects structurally broken input without throwing", async () => {
    for (const token of [
      "",
      ".",
      "no-separator",
      ".onlysignature",
      "onlypayload.",
      "not-base64url!.also-not",
    ]) {
      expect((await verifyPreviewToken(token, { now: NOW })).valid, token).toBe(
        false,
      );
    }
  });
});

describe("createPreviewLink", () => {
  it("points at the redemption route and carries a verifiable token", async () => {
    const { url, expiresAt } = await createPreviewLink(
      { path: "/blog/abc123", tenantId: TENANT },
      { now: NOW },
    );

    const parsed = new URL(url);
    expect(parsed.pathname).toBe(PREVIEW_ENTER_PATH);
    expect(expiresAt.getTime()).toBe(
      NOW.getTime() + PREVIEW_TOKEN_TTL_SECONDS * 1000,
    );

    const token = parsed.searchParams.get("token");
    expect(token).not.toBeNull();

    const result = await verifyPreviewToken(token as string, { now: NOW });
    expect(result.valid && result.payload.path).toBe("/blog/abc123");
  });

  it("carries the workspace it was minted in", async () => {
    const { url } = await createPreviewLink(
      { path: "/blog/abc123", tenantId: TENANT },
      { now: NOW },
    );
    const token = new URL(url).searchParams.get("token") as string;

    const result = await verifyPreviewToken(token, { now: NOW });
    expect(result.valid && result.payload.tenantId).toBe(TENANT);
  });

  it("is absolute, because the consumer is an external CMS", async () => {
    const { url } = await createPreviewLink({
      path: "/blog/abc123",
      tenantId: TENANT,
    });
    expect(url).toMatch(/^https?:\/\//);
  });
});
