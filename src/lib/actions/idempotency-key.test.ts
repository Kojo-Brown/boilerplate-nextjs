import { describe, it, expect, afterEach, vi } from "vitest";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  NoRandomSourceError,
  idempotencyKeySchema,
  newIdempotencyKey,
} from "./idempotency-key";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Replaces `globalThis.crypto` for one test and reports how to put it back. */
function withCrypto(replacement: Partial<Crypto> | undefined): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");

  Object.defineProperty(globalThis, "crypto", {
    value: replacement,
    configurable: true,
    writable: true,
  });

  return () => {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("newIdempotencyKey", () => {
  it("produces a v4 UUID", () => {
    expect(newIdempotencyKey()).toMatch(UUID_V4);
  });

  it("produces a different key every time", () => {
    const keys = new Set(Array.from({ length: 200 }, newIdempotencyKey));
    expect(keys.size).toBe(200);
  });

  it("produces a key the schema accepts", () => {
    expect(idempotencyKeySchema.safeParse(newIdempotencyKey()).success).toBe(
      true,
    );
  });

  it("falls back to getRandomValues outside a secure context", () => {
    // `crypto.randomUUID` is restricted to secure contexts, so it is undefined
    // on plain http over a LAN address — the shape of every "open the dev
    // server on my phone" setup. `getRandomValues` has no such restriction.
    const restore = withCrypto({
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.fill(0xab);
        return array;
      },
    });

    try {
      const key = newIdempotencyKey();
      expect(key).toMatch(UUID_V4);
      // The version and variant nibbles are stamped over the random bytes, so
      // an all-0xab buffer still comes out a well-formed v4: byte 6 becomes
      // 0x4b, and byte 8 is already variant-correct at 0xab.
      expect(key).toBe("abababab-abab-4bab-abab-abababababab");
    } finally {
      restore();
    }
  });

  it("throws rather than falling back to Math.random", () => {
    // A weak generator would let two of one user's submissions collide, and the
    // second would be answered with the first one's result. Failing is honest.
    const restore = withCrypto(undefined);

    try {
      expect(() => newIdempotencyKey()).toThrow(NoRandomSourceError);
    } finally {
      restore();
    }
  });
});

describe("idempotencyKeySchema", () => {
  it("rejects a key too short to be collision-free", () => {
    const result = idempotencyKeySchema.safeParse(
      "x".repeat(IDEMPOTENCY_KEY_MIN_LENGTH - 1),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a key longer than the column bound", () => {
    const result = idempotencyKeySchema.safeParse(
      "x".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1),
    );
    expect(result.success).toBe(false);
  });

  it("trims surrounding whitespace before measuring", () => {
    const padded = `  ${"x".repeat(IDEMPOTENCY_KEY_MIN_LENGTH)}  `;
    const result = idempotencyKeySchema.safeParse(padded);

    expect(result.success).toBe(true);
    if (result.success) {
      // The trimmed value is what is stored, so two spellings of one key are
      // one key rather than two rows that never match each other.
      expect(result.data).toBe("x".repeat(IDEMPOTENCY_KEY_MIN_LENGTH));
    }
  });

  it("rejects a value that is not a string", () => {
    expect(idempotencyKeySchema.safeParse(12345678901234567890).success).toBe(
      false,
    );
    expect(idempotencyKeySchema.safeParse(null).success).toBe(false);
  });

  it("accepts a non-UUID key a caller already has", () => {
    // The server's interest is that the value is opaque and bounded, not that
    // it matches a format. A request id a client already carries is fine.
    expect(
      idempotencyKeySchema.safeParse("req_01HZY8Q3M4N5P6R7S8T9V0W1X2").success,
    ).toBe(true);
  });
});
