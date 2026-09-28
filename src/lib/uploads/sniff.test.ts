import { describe, it, expect } from "vitest";
import {
  checkDeclaredType,
  SNIFFABLE_TYPES,
  SNIFF_BYTE_COUNT,
  sniffImageType,
} from "@/lib/uploads/sniff";
import { ALLOWED_MIME_TYPES } from "@/lib/uploads/policy";
import {
  EMPTY,
  GIF87_HEADER,
  GIF89_HEADER,
  GIF_JS_POLYGLOT,
  HEADER_BY_TYPE,
  HTML_DOCUMENT,
  JPEG_HEADER,
  PDF_DOCUMENT,
  PNG_HEADER,
  SVG_DOCUMENT,
  TRUNCATED_PNG,
  WEBP_HEADER,
  WINDOWS_EXECUTABLE,
} from "@/test/image-bytes";

describe("sniffImageType", () => {
  it("recognises each format from its documented signature", () => {
    expect(sniffImageType(JPEG_HEADER)).toBe("image/jpeg");
    expect(sniffImageType(PNG_HEADER)).toBe("image/png");
    expect(sniffImageType(GIF87_HEADER)).toBe("image/gif");
    expect(sniffImageType(GIF89_HEADER)).toBe("image/gif");
    expect(sniffImageType(WEBP_HEADER)).toBe("image/webp");
  });

  it("accepts any four bytes where WebP carries its length", () => {
    // `RIFF` is followed by a little-endian size before `WEBP`, and the size is
    // a property of the file rather than of the format. A signature that pinned
    // those bytes would recognise one WebP and reject every other.
    const header = Uint8Array.from(WEBP_HEADER);
    header.set([0xff, 0xee, 0xdd, 0xcc], 4);

    expect(sniffImageType(header)).toBe("image/webp");
  });

  it("returns null for a document that is not an image", () => {
    expect(sniffImageType(HTML_DOCUMENT)).toBeNull();
    expect(sniffImageType(PDF_DOCUMENT)).toBeNull();
    expect(sniffImageType(WINDOWS_EXECUTABLE)).toBeNull();
  });

  it("returns null for an SVG, which is why SVG is no longer accepted", () => {
    // SVG has no magic number — it is XML — and a well-formed SVG carrying a
    // `<script>` element is a well-formed SVG. There is no byte pattern that
    // separates a drawing from a document, so sniffing cannot make SVG safe and
    // the allowlist no longer pretends otherwise. See `@/lib/uploads/policy`.
    expect(sniffImageType(SVG_DOCUMENT)).toBeNull();
  });

  it("returns null for an empty or truncated input rather than guessing", () => {
    expect(sniffImageType(EMPTY)).toBeNull();
    expect(sniffImageType(TRUNCATED_PNG)).toBeNull();
  });

  it("reports a GIF/JavaScript polyglot as the GIF it leads with", () => {
    // The honest answer, and the documented limit of sniffing: these bytes are a
    // valid GIF header. What stops them being interpreted as script is the
    // Content-Type they are served with and `nosniff`, not this function — and
    // both of those are in place. What sniffing *does* catch is the same payload
    // declared as something else, which the mismatch test below covers.
    expect(sniffImageType(GIF_JS_POLYGLOT)).toBe("image/gif");
  });

  it("reads no further than the header, so trailing bytes cannot change it", () => {
    const withPayload = new Uint8Array(SNIFF_BYTE_COUNT);
    withPayload.set(PNG_HEADER, 0);
    withPayload.set(HTML_DOCUMENT, PNG_HEADER.length);

    expect(sniffImageType(withPayload)).toBe("image/png");
  });

  it("does not match a signature that appears after the start", () => {
    // Offset zero, not "contains". A file with a PNG signature buried in it is
    // not a PNG, and a substring search would have said it was.
    const shifted = new Uint8Array(PNG_HEADER.length + 1);
    shifted.set(PNG_HEADER, 1);

    expect(sniffImageType(shifted)).toBeNull();
  });
});

describe("SNIFFABLE_TYPES", () => {
  it("covers every type the allowlist accepts", () => {
    // The invariant gate rule R1 enforces at build time, asserted here too: an
    // allowed type with no signature either rejects every upload of that type or
    // gets "fixed" by treating an unrecognised type as acceptable, which is a
    // hole with a test suite over it.
    for (const type of ALLOWED_MIME_TYPES) {
      expect(SNIFFABLE_TYPES).toContain(type);
    }
  });

  it("claims no type the allowlist does not accept", () => {
    for (const type of SNIFFABLE_TYPES) {
      expect(ALLOWED_MIME_TYPES as readonly string[]).toContain(type);
    }
  });
});

describe("checkDeclaredType", () => {
  it("agrees when the bytes are what was declared", () => {
    for (const [type, header] of Object.entries(HEADER_BY_TYPE)) {
      expect(checkDeclaredType(header, type)).toEqual({
        agrees: true,
        type,
      });
    }
  });

  it("refuses bytes that are a different accepted format", () => {
    // The renamed-file case, and the one that decides the `Content-Type` a
    // browser will parse the bytes under.
    expect(checkDeclaredType(GIF89_HEADER, "image/png")).toEqual({
      agrees: false,
      declared: "image/png",
      detected: "image/gif",
    });
  });

  it("refuses a polyglot declared as something other than what it leads with", () => {
    expect(checkDeclaredType(GIF_JS_POLYGLOT, "image/png")).toEqual({
      agrees: false,
      declared: "image/png",
      detected: "image/gif",
    });
  });

  it("refuses an HTML document renamed to .png, the whole original bypass", () => {
    // Before this item there was no check on the bytes at all: `file.type` came
    // from the filename's extension, the schema checked that string, and the
    // presigned URL signed it — so renaming `payload.html` to `payload.png`
    // stored an HTML document that S3 would serve as `image/png`.
    expect(checkDeclaredType(HTML_DOCUMENT, "image/png")).toEqual({
      agrees: false,
      declared: "image/png",
      detected: null,
    });
  });

  it("refuses an SVG even when it is declared as one", () => {
    // Belt and braces with the allowlist: the type is refused because the
    // sniffer cannot recognise it *and* because it is not on the list.
    const result = checkDeclaredType(SVG_DOCUMENT, "image/svg+xml");

    expect(result.agrees).toBe(false);
    if (!result.agrees) expect(result.detected).toBeNull();
  });

  it("refuses a declared type the allowlist does not contain, even if the bytes match", () => {
    // Reaching this function with a type the schema would have refused means the
    // schema is no longer in the path, which is a reason to fail rather than to
    // trust the other layer. There is no such type whose bytes also sniff today,
    // so this asserts the guard directly.
    expect(checkDeclaredType(PNG_HEADER, "image/apng")).toEqual({
      agrees: false,
      declared: "image/apng",
      detected: "image/png",
    });
  });

  it("refuses an empty declared type, which is what a missing header parses to", () => {
    // `readObjectHead` defaults a missing `Content-Type` to the empty string
    // rather than to a guess, and this is what happens to it.
    expect(checkDeclaredType(PNG_HEADER, "").agrees).toBe(false);
  });
});
