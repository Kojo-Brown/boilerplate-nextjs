/**
 * AWS Signature Version 4 presigning over the Web Crypto API — no AWS SDK.
 *
 * One signer, four operations. Before this item there was one function that
 * presigned a PUT, because a PUT was all the upload path did: the browser wrote
 * the object and the server never looked at it again. Verifying an upload needs
 * to read the header bytes back, copy the object out of quarantine and delete
 * what it refuses, so the canonical-request assembly is now shared and the
 * method and signed headers are parameters.
 *
 * ## The header set is the security-relevant part
 *
 * For a presigned URL, every header named in `X-Amz-SignedHeaders` must arrive
 * with exactly the value that was signed, or S3 computes a different signature
 * and answers `SignatureDoesNotMatch`. That turns the signed header set into a
 * list of things the caller cannot change about the request, which is the only
 * enforcement available here — the URL itself is a bearer token, and anyone
 * holding it is the caller.
 *
 * So `content-length` is signed on the upload, and that is the fix for the size
 * cap. Previously the signed set was `content-type;host` over an
 * `UNSIGNED-PAYLOAD`, which authorised a PUT of *any* length: the 5 MB ceiling
 * was checked against a number the caller supplied and then dropped on the
 * floor, so a declared `sizeBytes: 1` minted a URL good for five gigabytes.
 * With the length signed, S3 holds the number, and the PUT has to carry exactly
 * it. A browser sets `Content-Length` itself from the `Blob` it is sending, so
 * the honest client needs no change; a caller sending more bytes than it
 * declared is refused by S3 before this application is involved.
 *
 * `UNSIGNED-PAYLOAD` stays, and has to: signing the payload hash would mean the
 * browser hashing the whole file before the first byte goes out, and the server
 * knowing that hash in advance, which for a file the server has never seen it
 * cannot. The length is the strongest constraint available without it — which is
 * why the readback in `@/lib/uploads/verify` re-measures what actually landed
 * rather than trusting that this held.
 */

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSHA256(
  key: BufferSource | string,
  message: string,
): Promise<ArrayBuffer> {
  const keyData: BufferSource =
    typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );
}

async function getSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kSecret: BufferSource = new TextEncoder().encode("AWS4" + secretKey);
  const kDate = await hmacSHA256(kSecret, dateStamp);
  const kRegion = await hmacSHA256(kDate, region);
  const kService = await hmacSHA256(kRegion, service);
  return hmacSHA256(kService, "aws4_request");
}

/** The credentials and location every operation needs. */
export interface S3Target {
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresIn?: number;
}

export interface PresignOptions extends S3Target {
  method: "GET" | "PUT" | "DELETE";
  /**
   * Headers to bind into the signature, lowercased. `host` is added here and
   * must not be passed. Every entry becomes a value the caller cannot vary.
   */
  headers?: Record<string, string>;
}

/** The bucket's virtual host for a region. */
export function bucketHost(bucket: string, region: string): string {
  return `${bucket}.s3.${region}.amazonaws.com`;
}

/**
 * Percent-encodes a key for a URL path, leaving the separators alone.
 *
 * Each segment is encoded independently so that `/` keeps its meaning as a
 * delimiter while a space or a `+` inside a segment does not.
 */
export function encodeKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** The unsigned URL an object is served from. */
export function objectUrl(options: {
  bucket: string;
  region: string;
  key: string;
}): string {
  return `https://${bucketHost(options.bucket, options.region)}/${encodeKey(options.key)}`;
}

/**
 * Builds a presigned URL for one S3 operation.
 *
 * Extracted from what used to be `createPresignedUploadUrl`'s body. The
 * canonical request is assembled exactly as before — the only change is that the
 * method and the signed header set come in as arguments instead of being
 * `"PUT"` and `content-type;host` literals.
 */
export async function presignS3Url(options: PresignOptions): Promise<string> {
  const {
    method,
    bucket,
    key,
    region,
    accessKeyId,
    secretAccessKey,
    headers = {},
    expiresIn = 3600,
  } = options;

  const host = bucketHost(bucket, region);
  const service = "s3";

  // Canonical headers are sorted by lowercased name and their values trimmed;
  // `SignedHeaders` is the same names in the same order, semicolon-separated.
  // Getting the order wrong produces a signature that is simply wrong, which
  // reads as a credentials problem — hence sorting here rather than relying on
  // callers to pass an ordered object.
  const allHeaders: Record<string, string> = { ...headers, host };
  const names = Object.keys(allHeaders)
    .map((name) => name.toLowerCase())
    .sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders =
    names
      .map((name) => `${name}:${String(allHeaders[name]).trim()}`)
      .join("\n") + "\n";

  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  const credential = `${accessKeyId}/${dateStamp}/${region}/${service}/aws4_request`;

  const queryParams = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": signedHeaders,
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
  });

  const sortedParams = Array.from(queryParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    method,
    `/${encodeKey(key)}`,
    sortedParams,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const canonicalRequestHash = toHex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalRequest),
    ),
  );

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    `${dateStamp}/${region}/${service}/aws4_request`,
    canonicalRequestHash,
  ].join("\n");

  const signingKey = await getSigningKey(
    secretAccessKey,
    dateStamp,
    region,
    service,
  );
  const signature = toHex(await hmacSHA256(signingKey, stringToSign));

  return `https://${host}/${encodeKey(key)}?${sortedParams}&X-Amz-Signature=${signature}`;
}

export interface PresignedUrlOptions extends S3Target {
  contentType: string;
  /**
   * The exact byte count the PUT must carry. Required, not optional: an optional
   * size cap is the defect this parameter exists to close, and a caller that
   * omits it would mint the unbounded URL this signature used to produce.
   */
  contentLength: number;
}

/**
 * The upload URL, and the key it writes to. Deliberately *not* a URL the object
 * can be read from.
 *
 * This result used to carry `publicUrl`, and handing that back was the shape of
 * the problem rather than a detail of it: the caller received a public URL for
 * an object whose bytes nothing had looked at, at the moment the URL was minted
 * — before the upload had even happened. `finalizeUploadAction` returns a URL,
 * after the readback, the sniff and the scan agree. Until then there is nothing
 * to give out.
 */
export interface PresignedUploadResult {
  uploadUrl: string;
  key: string;
}

export async function createPresignedUploadUrl(
  options: PresignedUrlOptions,
): Promise<PresignedUploadResult> {
  const uploadUrl = await presignS3Url({
    ...options,
    method: "PUT",
    headers: {
      "content-type": options.contentType,
      "content-length": String(options.contentLength),
    },
  });

  return { uploadUrl, key: options.key };
}

/**
 * A URL that reads the object — used with a `Range` header for the header bytes.
 *
 * `Range` is not signed, and it should not be: signing it would bind the URL to
 * one window of the object, and the header is not a permission (a caller who can
 * GET the object can GET all of it). What bounds the transfer is that
 * `readObjectHead` asks for a range and reads a bounded number of bytes from the
 * response, which is a property of that function rather than of this URL.
 */
export function createPresignedReadUrl(target: S3Target): Promise<string> {
  return presignS3Url({ ...target, method: "GET" });
}

/** A URL that deletes the object — how a refused upload leaves the bucket. */
export function createPresignedDeleteUrl(target: S3Target): Promise<string> {
  return presignS3Url({ ...target, method: "DELETE" });
}

/**
 * A URL that copies another key of the same bucket onto this one.
 *
 * S3 models a copy as a PUT whose body is empty and whose source is the
 * `x-amz-copy-source` header, so the source is signed: a URL minted to promote
 * one quarantined object cannot be redirected at another. The value is
 * `/<bucket>/<key>` with the key percent-encoded, which is the form S3 parses —
 * an unencoded space or `+` in it is a `404` on an object that exists.
 *
 * `content-type` is signed alongside it because a copy replaces the object's
 * metadata when any is supplied: the promoted object must be served as the type
 * the sniffer *confirmed*, not as whatever the original PUT declared.
 */
export function createPresignedCopyUrl(
  options: S3Target & { sourceKey: string; contentType: string },
): Promise<string> {
  return presignS3Url({
    ...options,
    method: "PUT",
    headers: {
      "x-amz-copy-source": `/${options.bucket}/${encodeKey(options.sourceKey)}`,
      "x-amz-metadata-directive": "REPLACE",
      "content-type": options.contentType,
    },
  });
}
