/**
 * Decides what a file *is* from its leading bytes, rather than from what the
 * caller said it was.
 *
 * ## What there was before
 *
 * Nothing. The upload path had three checks on the content type and not one of
 * them looked at the file. `ImageUpload` read `file.type`, which the browser
 * derives from the filename's extension; the Zod schema checked that string
 * against the allowlist; and `createPresignedUploadUrl` signed it into the URL.
 * All three are the same fact, asserted by the caller, repeated three times.
 *
 * Signing it is worth something — it stops a URL minted for a PNG being reused
 * for another type — but it also means the declared type becomes the object's
 * stored `Content-Type`, which is the header S3 serves the bytes back with. So
 * the allowlist was not deciding what got stored; it was deciding what a
 * caller's arbitrary bytes would later be labelled as. Renaming `payload.html`
 * to `payload.png` was the entire bypass.
 *
 * ## Why an allowlist of signatures rather than a blocklist
 *
 * The question is never "is this dangerous", which has no answer, but "is this
 * one of the four formats we serve". So this returns a type only for a pattern
 * it recognises and `null` for everything else, including the empty input and a
 * truncated header. A blocklist of known-bad magic numbers (`MZ`, `%PDF`,
 * `<?php`, `<!DOCTYPE`) would pass anything not on it, and the interesting
 * files are the ones nobody has thought of.
 *
 * `null` is also what a *polyglot* gets — a file crafted to be valid in two
 * formats at once — because a polyglot has to lead with one format's signature,
 * and whatever it leads with is the type this reports. `verifyUploadedObject`
 * then compares that with the declared type, and a GIF/JavaScript polyglot
 * declared as `image/png` is refused on the mismatch. A polyglot declared as the
 * format it actually leads with is stored as that format, which is the honest
 * limit of sniffing and is written down in `docs/uploads.md`: bytes that really
 * are a valid GIF are a valid GIF, and what stops them being interpreted as
 * script is the `Content-Type` they are served with and `X-Content-Type-Options:
 * nosniff`, not this function.
 */
import { ALLOWED_MIME_TYPES } from "@/lib/uploads/policy";
import type { AllowedMimeType } from "@/lib/uploads/policy";

/**
 * How many leading bytes the caller needs to hand us.
 *
 * Twelve would do for the longest signature below (WebP's `RIFF….WEBP`), and
 * 512 is what the readback asks S3 for anyway: it is a single packet either
 * way, it leaves room for a signature that needs more context than twelve
 * bytes, and it means a future check on the header — an EXIF scan, an ICC
 * profile — does not change the range request.
 */
export const SNIFF_BYTE_COUNT = 512;

interface Signature {
  readonly type: AllowedMimeType;
  /**
   * Byte values at fixed offsets from the start. `null` means "any byte here",
   * which WebP needs: `RIFF` is followed by a four-byte little-endian length
   * before `WEBP`, and the length is a property of the file, not of the format.
   */
  readonly bytes: readonly (number | null)[];
}

const ascii = (text: string): number[] =>
  Array.from(text, (character) => character.charCodeAt(0));

/**
 * The four signatures, longest-first within a format family.
 *
 * Each is the format's documented header, not a heuristic:
 *
 *   - JPEG — `FF D8 FF`, the SOI marker plus the first byte of the marker that
 *     always follows it. Two bytes would match more loosely for no gain.
 *   - PNG  — the eight-byte signature from the specification, which includes
 *     `\r\n` and `\x1a` precisely so that a transfer that mangles line endings
 *     or truncates at an EOF character is detectable.
 *   - GIF  — `GIF87a` or `GIF89a`; there is no third version.
 *   - WebP — `RIFF`, four bytes of length, then `WEBP`.
 */
const SIGNATURES: readonly Signature[] = [
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  {
    type: "image/png",
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { type: "image/gif", bytes: ascii("GIF87a") },
  { type: "image/gif", bytes: ascii("GIF89a") },
  {
    type: "image/webp",
    bytes: [...ascii("RIFF"), null, null, null, null, ...ascii("WEBP")],
  },
];

/**
 * Every type the sniffer can recognise.
 *
 * Exported for gate rule R1, which fails the build if `ALLOWED_MIME_TYPES`
 * grows an entry this set does not cover. That is the rule that keeps the two
 * lists from drifting: an allowed type with no signature is a type that reaches
 * `verifyUploadedObject` and is refused on every upload — a feature that looks
 * implemented and rejects everything — or, if someone "fixes" that by treating
 * an unrecognised type as acceptable, a hole with a test suite over it.
 */
export const SNIFFABLE_TYPES: readonly AllowedMimeType[] = Array.from(
  new Set(SIGNATURES.map((signature) => signature.type)),
);

function matches(bytes: Uint8Array, signature: Signature): boolean {
  if (bytes.length < signature.bytes.length) return false;

  return signature.bytes.every(
    (expected, index) => expected === null || bytes[index] === expected,
  );
}

/**
 * The type these bytes actually are, or `null` for anything unrecognised.
 *
 * Takes a `Uint8Array` rather than a `Blob` or a `File` so it is synchronous
 * and runs identically on both sides: the browser hands it a slice of a `File`,
 * the server hands it the body of a range request.
 */
export function sniffImageType(bytes: Uint8Array): AllowedMimeType | null {
  for (const signature of SIGNATURES) {
    if (matches(bytes, signature)) return signature.type;
  }
  return null;
}

/**
 * Whether the bytes are what the caller claimed.
 *
 * A separate function from `sniffImageType` because the interesting failure is
 * not "unrecognised" but "recognised as something else", and the two want
 * different messages: one is "we do not accept this format", the other is "you
 * told us this was a PNG and it is a GIF", which is either a confused client or
 * an attempt to choose the `Content-Type` a browser will later parse these
 * bytes under.
 */
export type SniffResult =
  | { agrees: true; type: AllowedMimeType }
  | { agrees: false; declared: string; detected: AllowedMimeType | null };

export function checkDeclaredType(
  bytes: Uint8Array,
  declared: string,
): SniffResult {
  const detected = sniffImageType(bytes);

  // The declared type is checked against the allowlist here as well as in the
  // action's schema, and deliberately so: this function is the one that decides
  // whether an object is kept, and a caller reaching it with a type the schema
  // would have refused means the schema is no longer in the path — which is a
  // reason to fail, not to trust the other layer.
  if (
    detected === null ||
    detected !== declared ||
    !(ALLOWED_MIME_TYPES as readonly string[]).includes(declared)
  ) {
    return { agrees: false, declared, detected };
  }

  return { agrees: true, type: detected };
}
