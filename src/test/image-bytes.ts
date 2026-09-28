/**
 * Minimal, obviously-fake byte headers for the four formats the sniffer knows,
 * plus the shapes it has to refuse.
 *
 * These are headers, not images: enough leading bytes to carry each format's
 * signature and nothing after them. That is exactly what `sniffImageType` reads,
 * so a real photograph would add kilobytes and test nothing extra — and a
 * fixture nobody can read at a glance is a fixture that stops being checked
 * against the specification it came from.
 *
 * Shared by the sniffer's own tests, the verification tests, and the component
 * test, so that all three agree on what a PNG looks like.
 */

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

const ascii = (text: string): number[] =>
  Array.from(text, (character) => character.charCodeAt(0));

/** SOI marker plus the first byte of the marker that always follows it. */
export const JPEG_HEADER = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);

/** The eight-byte PNG signature from the specification, then an IHDR length. */
export const PNG_HEADER = bytes(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
);

export const GIF87_HEADER = bytes(...ascii("GIF87a"), 0x01, 0x00);
export const GIF89_HEADER = bytes(...ascii("GIF89a"), 0x01, 0x00);

/** `RIFF`, a four-byte little-endian length, then `WEBP`. */
export const WEBP_HEADER = bytes(
  ...ascii("RIFF"),
  0x24,
  0x00,
  0x00,
  0x00,
  ...ascii("WEBP"),
  ...ascii("VP8 "),
);

/**
 * Things that must not sniff as an image.
 *
 * `SVG_DOCUMENT` is here rather than in the accepted set on purpose: it is a
 * well-formed SVG that would have been accepted before this item, and the script
 * in it is why `image/svg+xml` left the allowlist. Nothing in it is dangerous to
 * run — there is no network call and no payload — but it is the shape a stored
 * XSS takes, and a test that used a blank `<svg/>` would not be testing the case
 * anybody cares about.
 *
 * `GIF_JS_POLYGLOT` is the classic one: bytes that are simultaneously a valid
 * GIF header and a valid JavaScript assignment, because `GIF89a` parses as an
 * expression and `/*` opens a comment. It sniffs as a GIF, which is the honest
 * answer — see the note in `@/lib/uploads/sniff` about what sniffing can and
 * cannot settle.
 */
export const HTML_DOCUMENT = new TextEncoder().encode(
  "<!DOCTYPE html>\n<html><body>not an image</body></html>\n",
);

export const SVG_DOCUMENT = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' +
    "<script>/* would run in the bucket's origin */</script></svg>",
);

export const WINDOWS_EXECUTABLE = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00);

export const PDF_DOCUMENT = new TextEncoder().encode(
  "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n",
);

export const GIF_JS_POLYGLOT = new TextEncoder().encode(
  "GIF89a/*=1;alert(1)//*/",
);

/** A truncated PNG signature: the right bytes, not enough of them. */
export const TRUNCATED_PNG = bytes(0x89, 0x50, 0x4e);

export const EMPTY = new Uint8Array(0);

/** The bytes for a type, for tests that are parameterised over the allowlist. */
export const HEADER_BY_TYPE = {
  "image/jpeg": JPEG_HEADER,
  "image/png": PNG_HEADER,
  "image/gif": GIF89_HEADER,
  "image/webp": WEBP_HEADER,
} as const;
