/**
 * The HMAC key derivation this application shares between its two signers.
 *
 * ## Why derive rather than sign with the secret directly
 *
 * Two features now hold a signing key: preview links (`@/lib/preview/token`)
 * and the revalidation webhook (`@/lib/webhooks/signature`). Both fall back to
 * `NEXTAUTH_SECRET` when their own secret is unset, because requiring a second
 * mandatory secret to enable an optional feature is how placeholder secrets end
 * up committed. Falling back is only safe if the two never hold the same bytes:
 * a preview token and a webhook signature must not be verifiable by each
 * other's verifier, or a capability minted for one purpose is a capability for
 * the other.
 *
 * HKDF with a distinct `info` per purpose is what buys that. The inputs are
 * public except the secret; the `info` string is the domain separator, and two
 * derivations differing only in it produce unrelated keys.
 *
 * ## Why this module exists at all
 *
 * The derivation was written once for preview tokens and would have been
 * written a second time for the webhook. A duplicated key derivation is the
 * kind of code that stays in step until someone changes one copy — and the
 * failure mode of the copies drifting is not a broken build, it is two
 * deployments that disagree about whether a signature is valid. One
 * implementation, parameterised by the two strings that are supposed to differ.
 *
 * ## Runtime
 *
 * Web Crypto and `TextEncoder` only — no `node:crypto`, no `Buffer`. That is
 * what keeps both `/api/preview` and `/api/revalidate` declarable as
 * `portable: true` in `@/lib/api/runtimes`, a claim
 * `scripts/assert-api-runtimes.ts` checks against the build's dependency trace.
 */

const encoder = new TextEncoder();

export interface HmacKeySpec {
  /** The input keying material. Never used as a key directly. */
  secret: string;
  /**
   * HKDF's salt. Optional and public in the RFC; a fixed non-empty value is
   * preferred to an empty one purely because it pins a derivation to this
   * application.
   */
  salt: string;
  /**
   * The domain separator. This is the field that makes "the preview key" a
   * different key from "the webhook key" when both descend from one secret, so
   * every caller must pass its own and must never change it casually: changing
   * it invalidates every outstanding signature made under the old one.
   */
  info: string;
}

/**
 * Derives a non-extractable HMAC-SHA256 key.
 *
 * `extractable: false` means the raw bytes cannot be read back out of the
 * `CryptoKey`, so a reference to it that escapes into a log or an error object
 * is not the secret.
 */
export async function deriveHmacKey(spec: HmacKeySpec): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(spec.secret),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(spec.salt),
      info: encoder.encode(spec.info),
    },
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Lowercase hex, which is what a webhook signature header carries.
 *
 * Hex rather than base64url for the wire format of a signature: it is what
 * every CMS's outgoing-webhook implementation already produces, it has no
 * padding or alphabet variants to disagree about, and a hand-written `curl`
 * reproduction of a signature is `openssl dgst -sha256 -hmac` away. Preview
 * tokens use base64url instead, because there the encoded value is a URL
 * parameter carrying a payload as well and length matters.
 */
export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Throws on anything `toHex` could not have produced.
 *
 * The return type is `Uint8Array<ArrayBuffer>` rather than the default
 * `Uint8Array<ArrayBufferLike>` because `crypto.subtle.verify` takes a
 * `BufferSource`, and a `SharedArrayBuffer`-backed view is not one. Allocating
 * the `ArrayBuffer` explicitly is what makes that true by construction — the
 * alternative is a cast asserting something this function can simply be.
 */
export function fromHex(value: string): Uint8Array<ArrayBuffer> {
  if (
    value.length === 0 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(value)
  ) {
    throw new Error("Not lowercase hex of whole bytes.");
  }

  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
