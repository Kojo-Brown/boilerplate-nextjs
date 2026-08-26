import { describe, it, expect } from "vitest";
import { deriveHmacKey, fromHex, toHex } from "./hmac";

const encoder = new TextEncoder();

const SECRET = "a-test-secret-that-is-at-least-32-characters";
const SALT = "test/salt/v1";

async function sign(key: CryptoKey, message: string): Promise<string> {
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(message)),
    ),
  );
}

/**
 * The property this module exists for.
 *
 * Both signers in this application fall back to `NEXTAUTH_SECRET`, so the only
 * thing keeping a preview token from being a valid webhook signature is the
 * `info` string. That is worth an assertion rather than a comment: the whole
 * fallback design rests on it, and nothing else in the codebase would fail if
 * it stopped being true.
 */
describe("deriveHmacKey", () => {
  it("derives unrelated keys from one secret for different purposes", async () => {
    const preview = await deriveHmacKey({
      secret: SECRET,
      salt: SALT,
      info: "purpose/preview",
    });
    const webhook = await deriveHmacKey({
      secret: SECRET,
      salt: SALT,
      info: "purpose/webhook",
    });

    expect(await sign(preview, "same message")).not.toBe(
      await sign(webhook, "same message"),
    );
  });

  it("is deterministic for the same secret, salt and info", async () => {
    const spec = { secret: SECRET, salt: SALT, info: "purpose/preview" };

    expect(await sign(await deriveHmacKey(spec), "m")).toBe(
      await sign(await deriveHmacKey(spec), "m"),
    );
  });

  it("changes with the secret, which is what makes rotation work", async () => {
    const first = await deriveHmacKey({
      secret: SECRET,
      salt: SALT,
      info: "p",
    });
    const second = await deriveHmacKey({
      secret: `${SECRET}-rotated`,
      salt: SALT,
      info: "p",
    });

    expect(await sign(first, "m")).not.toBe(await sign(second, "m"));
  });

  it("changes with the salt", async () => {
    const first = await deriveHmacKey({
      secret: SECRET,
      salt: "salt/a",
      info: "p",
    });
    const second = await deriveHmacKey({
      secret: SECRET,
      salt: "salt/b",
      info: "p",
    });

    expect(await sign(first, "m")).not.toBe(await sign(second, "m"));
  });

  it("produces a key whose bytes cannot be read back out", async () => {
    const key = await deriveHmacKey({ secret: SECRET, salt: SALT, info: "p" });

    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });
});

describe("toHex / fromHex", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 127, 128, 254, 255]);

    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  it("pads each byte to two digits", () => {
    // The bug this rules out is a `toString(16)` without the pad: `[0, 10]`
    // would encode as `"0a"` — the same string as `[10]` — so two different
    // signatures would compare equal.
    expect(toHex(new Uint8Array([0, 10]))).toBe("000a");
  });

  it("rejects an odd number of digits", () => {
    expect(() => fromHex("abc")).toThrow();
  });

  it("rejects non-hex characters", () => {
    expect(() => fromHex("zz")).toThrow();
  });

  it("rejects the empty string", () => {
    // Not an academic case: a header ending `v1=` parses to an empty value, and
    // an empty signature must be a rejection rather than a zero-length compare.
    expect(() => fromHex("")).toThrow();
  });

  it("accepts uppercase, which some senders emit", () => {
    expect(fromHex("FF")).toEqual(new Uint8Array([255]));
  });

  it("returns a view backed by a plain ArrayBuffer", () => {
    // `crypto.subtle.verify` takes a `BufferSource`, and a SharedArrayBuffer
    // view is not one. The type says so; this checks the runtime agrees.
    expect(fromHex("00ff").buffer).toBeInstanceOf(ArrayBuffer);
  });
});
