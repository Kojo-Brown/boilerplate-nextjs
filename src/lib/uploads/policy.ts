/**
 * What this application accepts as an upload, and the two key spaces an object
 * moves between on its way to being served.
 *
 * Split out of `@/lib/s3` because these constants and that module have opposite
 * audiences. The allowlist and the size cap are read by `ImageUpload`, a
 * `"use client"` component, which put the whole SigV4 signer — `crypto.subtle`
 * key derivation, canonical request assembly, the lot — into the browser bundle
 * to reach four string literals. Nothing here imports anything, so it is safe
 * in either graph and costs a bundle almost nothing.
 *
 * ## Why the allowlist lost `image/svg+xml`
 *
 * It was accepted, and it is the one type on the old list that content sniffing
 * cannot help with. The three other checks this item adds all reduce to "do the
 * bytes agree with the declared type", and an SVG that carries
 * `<script>fetch("https://…", {credentials:"include"})</script>` agrees
 * perfectly: it is a well-formed SVG. There is no byte pattern separating a
 * drawing from a document, because in SVG they are the same format.
 *
 * What makes that matter is where the bytes are served from. An object at
 * `publicUrl` is fetched with the `Content-Type` the PUT signed, so a stored
 * `image/svg+xml` is handed to the browser as a document to parse and its
 * scripts run in the *bucket's* origin. On a raw `bucket.s3.region.amazonaws.com`
 * URL that origin shares nothing with the application, and the damage is a
 * phishing page on a domain the organisation owns. Behind the CDN alias most
 * deployments put in front of a bucket — `cdn.example.com`, or a path on the
 * application's own host — it is same-site, and on the same host it is stored
 * XSS with the session cookie attached. Which of those a deployment has is not
 * something this repository can know, and it is not a question the upload path
 * should be answering by default.
 *
 * So SVG is refused, and re-enabling it is deliberately not an environment
 * variable: a flag that switches stored XSS back on is a footgun with a label
 * on it. A deployment that needs user SVG needs a sanitiser that parses the
 * document and strips script, event handlers, external references and
 * `foreignObject` — not an allowlist entry. `docs/uploads.md` says so at
 * length, and gate rule R1 refuses any allowed type the sniffer cannot
 * recognise, so the list cannot grow back past the sniffer by accident.
 */

/** Types a caller may declare, and the only types the sniffer recognises. */
export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export function isAllowedMimeType(type: string): type is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(type);
}

/**
 * The extension written into the key for each type we accept.
 *
 * Derived from the content type rather than from the caller's filename, which
 * is the property `src/actions/upload.ts` explains: no caller string reaches
 * the key at all, so there is no path traversal to sanitise.
 */
export const EXTENSION_BY_MIME_TYPE: Record<AllowedMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * The ceiling on a single object, 5 MB.
 *
 * Before this item it was advisory in the only place it mattered. The schema
 * checked the *declared* `sizeBytes` and then dropped it: the presigned URL
 * signed `content-type;host` over an `UNSIGNED-PAYLOAD`, so the URL it minted
 * authorised a PUT of any length whatsoever. A caller declaring one byte could
 * write five gigabytes with it and every check in the process had passed.
 *
 * It is now signed into the URL as `content-length`, so S3 itself holds the
 * number, and the readback re-measures what actually landed. See
 * `createPresignedUploadUrl`.
 */
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Where an object lands, and where it is served from once it is verified.
 *
 * Two prefixes rather than one plus a flag, because the property worth having
 * is "an unverified object is not reachable at a public URL", and a prefix is
 * something a bucket policy can act on. `quarantine/*` is meant to be private
 * in the bucket policy and `uploads/*` public; `docs/uploads.md` has the
 * policy. With one prefix the object would sit at its final URL for as long as
 * verification takes, and an unguessable key is secrecy, not a boundary.
 */
export const QUARANTINE_PREFIX = "quarantine";
export const PUBLIC_PREFIX = "uploads";

/**
 * The shape of every key this application mints, anchored at both ends.
 *
 * The user segment is what makes a key an access-control decision rather than a
 * string: `finalizeUploadAction` re-derives the caller's own prefix and refuses
 * a key outside it, so one user cannot verify, promote or delete another's
 * object. The id is character-constrained even though it comes from the session
 * rather than from a caller — a `/` or a `..` in it would escape the prefix
 * that check relies on, and "the database would never produce one" is the kind
 * of assumption that outlives the schema that made it true.
 */
const KEY_PATTERN = new RegExp(
  `^(${QUARANTINE_PREFIX}|${PUBLIC_PREFIX})/([A-Za-z0-9_-]{1,64})/(\\d{13,}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.([a-z0-9]{3,4})$`,
);

export interface ParsedKey {
  prefix: typeof QUARANTINE_PREFIX | typeof PUBLIC_PREFIX;
  userId: string;
  /** The `<timestamp>-<uuid>` stem, without the extension. */
  name: string;
  extension: string;
}

/**
 * Parses a key, or returns `null` for anything this application did not mint.
 *
 * `null` rather than a throw: the one caller is a Server Action handling a
 * value that arrived over the network, and "not a key" is an ordinary failure
 * there, not an exception.
 */
export function parseObjectKey(key: string): ParsedKey | null {
  const match = KEY_PATTERN.exec(key);
  if (!match) return null;

  const extension = match[4]!;
  if (!Object.values(EXTENSION_BY_MIME_TYPE).includes(extension)) return null;

  return {
    prefix: match[1] as ParsedKey["prefix"],
    userId: match[2]!,
    name: match[3]!,
    extension,
  };
}

/** The type an object's extension implies, or `null` for an unknown one. */
export function mimeTypeForExtension(
  extension: string,
): AllowedMimeType | null {
  for (const [type, ext] of Object.entries(EXTENSION_BY_MIME_TYPE)) {
    if (ext === extension) return type as AllowedMimeType;
  }
  return null;
}

/**
 * Mints the quarantine key an upload is written to.
 *
 * The timestamp is there to make the key sort and to make a collision need two
 * events in the same millisecond *and* a UUID collision; the UUID is what
 * actually makes it unique.
 */
export function buildQuarantineKey(options: {
  userId: string;
  contentType: AllowedMimeType;
}): string {
  const extension = EXTENSION_BY_MIME_TYPE[options.contentType];
  return `${QUARANTINE_PREFIX}/${options.userId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
}

/**
 * The public key a verified quarantine object is copied to.
 *
 * Only the prefix changes, so the two keys are the same object under two
 * policies and there is nothing to correlate them by later.
 */
export function promotedKeyFor(quarantineKey: string): string | null {
  const parsed = parseObjectKey(quarantineKey);
  if (!parsed || parsed.prefix !== QUARANTINE_PREFIX) return null;
  return `${PUBLIC_PREFIX}/${parsed.userId}/${parsed.name}.${parsed.extension}`;
}
