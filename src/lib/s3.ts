/**
 * AWS S3 presigned URL generation using the Web Crypto API (no AWS SDK required).
 * Implements AWS Signature Version 4 for PUT presigned URLs.
 */

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSHA256(key: BufferSource | string, message: string): Promise<ArrayBuffer> {
  const keyData: BufferSource =
    typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
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

export interface PresignedUrlOptions {
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  contentType: string;
  expiresIn?: number;
}

export interface PresignedUploadResult {
  uploadUrl: string;
  publicUrl: string;
  key: string;
}

export async function createPresignedUploadUrl(
  options: PresignedUrlOptions,
): Promise<PresignedUploadResult> {
  const { bucket, key, region, accessKeyId, secretAccessKey, contentType, expiresIn = 3600 } =
    options;

  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const service = "s3";

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  const credential = `${accessKeyId}/${dateStamp}/${region}/${service}/aws4_request`;
  const signedHeaders = "host";

  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const queryParams = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": signedHeaders,
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
  });

  // Sort query params alphabetically (required for canonical query string)
  const sortedParams = Array.from(queryParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    "PUT",
    `/${encodedKey}`,
    sortedParams,
    `host:${host}\n`,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const canonicalRequestHash = toHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest)),
  );

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    `${dateStamp}/${region}/${service}/aws4_request`,
    canonicalRequestHash,
  ].join("\n");

  const signingKey = await getSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = toHex(await hmacSHA256(signingKey, stringToSign));

  const uploadUrl = `https://${host}/${encodedKey}?${sortedParams}&X-Amz-Signature=${signature}`;
  const publicUrl = `https://${host}/${encodedKey}`;

  return { uploadUrl, publicUrl, key };
}

export type AllowedMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif"
  | "image/svg+xml";

export const ALLOWED_MIME_TYPES: AllowedMimeType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
];

export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

export function isAllowedMimeType(type: string): type is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as string[]).includes(type);
}
