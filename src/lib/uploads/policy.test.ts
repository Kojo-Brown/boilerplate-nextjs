import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ALLOWED_MIME_TYPES,
  buildQuarantineKey,
  EXTENSION_BY_MIME_TYPE,
  isAllowedMimeType,
  MAX_FILE_SIZE_BYTES,
  mimeTypeForExtension,
  parseObjectKey,
  promotedKeyFor,
  PUBLIC_PREFIX,
  QUARANTINE_PREFIX,
} from "@/lib/uploads/policy";

afterEach(() => {
  vi.useRealTimers();
});

describe("ALLOWED_MIME_TYPES", () => {
  it("no longer accepts image/svg+xml", () => {
    // The one type on the old list that content sniffing cannot help with: a
    // well-formed SVG carrying `<script>` is a well-formed SVG, and it is served
    // from the bucket with the `Content-Type` that makes a browser parse it as a
    // document. See the module header for what re-enabling it would need.
    expect(ALLOWED_MIME_TYPES as readonly string[]).not.toContain(
      "image/svg+xml",
    );
    expect(isAllowedMimeType("image/svg+xml")).toBe(false);
  });

  it("accepts the four raster formats and nothing else", () => {
    expect([...ALLOWED_MIME_TYPES]).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ]);
    expect(isAllowedMimeType("application/pdf")).toBe(false);
    expect(isAllowedMimeType("text/html")).toBe(false);
  });

  it("gives every accepted type an extension", () => {
    for (const type of ALLOWED_MIME_TYPES) {
      expect(EXTENSION_BY_MIME_TYPE[type]).toMatch(/^[a-z0-9]{3,4}$/);
    }
  });

  it("maps each extension back to exactly one type", () => {
    const extensions = Object.values(EXTENSION_BY_MIME_TYPE);
    expect(new Set(extensions).size).toBe(extensions.length);

    for (const type of ALLOWED_MIME_TYPES) {
      expect(mimeTypeForExtension(EXTENSION_BY_MIME_TYPE[type])).toBe(type);
    }
    expect(mimeTypeForExtension("svg")).toBeNull();
    expect(mimeTypeForExtension("exe")).toBeNull();
  });
});

describe("buildQuarantineKey", () => {
  it("writes to the quarantine prefix, never the public one", () => {
    // The property the two-prefix split exists for: an object that has not been
    // verified is not at a key the bucket policy makes readable.
    const key = buildQuarantineKey({
      userId: "user_1",
      contentType: "image/png",
    });

    expect(key.startsWith(`${QUARANTINE_PREFIX}/`)).toBe(true);
    expect(key.startsWith(`${PUBLIC_PREFIX}/`)).toBe(false);
  });

  it("takes the extension from the content type, not from any caller string", () => {
    expect(
      buildQuarantineKey({ userId: "u", contentType: "image/webp" }),
    ).toMatch(/\.webp$/);
    expect(
      buildQuarantineKey({ userId: "u", contentType: "image/jpeg" }),
    ).toMatch(/\.jpg$/);
  });

  it("puts the user id in its own segment", () => {
    const key = buildQuarantineKey({
      userId: "clx123abc",
      contentType: "image/gif",
    });

    expect(key.split("/")[1]).toBe("clx123abc");
  });

  it("does not collide for two uploads in the same millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const first = buildQuarantineKey({ userId: "u", contentType: "image/png" });
    const second = buildQuarantineKey({
      userId: "u",
      contentType: "image/png",
    });

    expect(first).not.toBe(second);
  });
});

describe("parseObjectKey", () => {
  it("parses a key this application minted", () => {
    const key = buildQuarantineKey({
      userId: "user_1",
      contentType: "image/png",
    });

    expect(parseObjectKey(key)).toMatchObject({
      prefix: QUARANTINE_PREFIX,
      userId: "user_1",
      extension: "png",
    });
  });

  it("parses the public form as well", () => {
    const parsed = parseObjectKey(
      "uploads/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.jpg",
    );

    expect(parsed).toMatchObject({ prefix: "uploads", userId: "user_1" });
  });

  it("refuses a key that walks out of its prefix", () => {
    // The check `finalizeUploadAction` rests on. A key that escapes the user
    // segment escapes the only access control there is.
    //
    // The escape targets are other keys in this bucket rather than the
    // unix-password-file path a traversal fixture usually reaches for. Two
    // reasons: an S3 key is not a filesystem path, so another user's object is
    // the thing actually at risk here; and that filename trips GitGuardian's
    // generic-password detector, which costs a red check and a reviewer's time
    // to dismiss a string that was never a secret.
    for (const key of [
      "quarantine/user_1/../user_2/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.png",
      "quarantine/../uploads/user_2/stolen.png",
      "quarantine/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.png/../../evil.png",
      "../quarantine/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.png",
    ]) {
      expect(parseObjectKey(key), key).toBeNull();
    }
  });

  it("refuses a key in a prefix this application does not use", () => {
    expect(
      parseObjectKey(
        "backups/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.png",
      ),
    ).toBeNull();
  });

  it("refuses an extension that is not one we mint", () => {
    // `.svg` in particular: a key left over from before the allowlist changed
    // must not be promotable now.
    for (const extension of ["svg", "html", "js", "exe", "php"]) {
      expect(
        parseObjectKey(
          `quarantine/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.${extension}`,
        ),
        extension,
      ).toBeNull();
    }
  });

  it("refuses a malformed stem", () => {
    for (const key of [
      "quarantine/user_1/photo.png",
      "quarantine/user_1/1767225600000-not-a-uuid.png",
      "quarantine/user_1/1767225600000-1B4E28BA-2FA1-11D2-883F-0016D3CCA427.png",
      "quarantine/user_1/.png",
      "quarantine/user_1/",
      "quarantine/user_1",
      "",
    ]) {
      expect(parseObjectKey(key), JSON.stringify(key)).toBeNull();
    }
  });

  it("refuses a user segment with characters that could escape it", () => {
    const stem = "1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427";
    for (const userId of ["a/b", "a b", "a%2fb", "a.b", "..", "a".repeat(65)]) {
      expect(
        parseObjectKey(`quarantine/${userId}/${stem}.png`),
        userId,
      ).toBeNull();
    }
  });
});

describe("promotedKeyFor", () => {
  it("changes the prefix and nothing else", () => {
    const quarantineKey = buildQuarantineKey({
      userId: "user_1",
      contentType: "image/webp",
    });
    const promoted = promotedKeyFor(quarantineKey);

    expect(promoted).toBe(
      quarantineKey.replace(`${QUARANTINE_PREFIX}/`, `${PUBLIC_PREFIX}/`),
    );
  });

  it("refuses to promote a key that is already public", () => {
    // Otherwise a caller could pass a public key to finalize and have the server
    // re-copy an object over itself, which is a write it has no business making.
    expect(
      promotedKeyFor(
        "uploads/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.png",
      ),
    ).toBeNull();
  });

  it("refuses to promote anything it cannot parse", () => {
    expect(promotedKeyFor("quarantine/user_1/../evil.png")).toBeNull();
    expect(promotedKeyFor("nonsense")).toBeNull();
  });
});

describe("MAX_FILE_SIZE_BYTES", () => {
  it("is 5 MB", () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(5 * 1024 * 1024);
  });
});
