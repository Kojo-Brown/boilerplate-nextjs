import { describe, it, expect } from "vitest";
import { createPresignedUploadUrl } from "./s3";

// Obviously-fake credentials: this is AWS's own documentation example key pair,
// which is not valid against any real account.
const BASE_OPTIONS = {
  bucket: "my-bucket",
  key: "uploads/user_1/photo.png",
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  contentType: "image/png",
};

function signatureOf(url: string): string {
  return new URL(url).searchParams.get("X-Amz-Signature") ?? "";
}

describe("createPresignedUploadUrl", () => {
  it("builds a SigV4 PUT URL against the bucket's virtual host", async () => {
    const { uploadUrl, publicUrl, key } =
      await createPresignedUploadUrl(BASE_OPTIONS);
    const parsed = new URL(uploadUrl);

    expect(parsed.host).toBe("my-bucket.s3.us-east-1.amazonaws.com");
    expect(parsed.pathname).toBe("/uploads/user_1/photo.png");
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-Credential")).toContain(
      "AKIAIOSFODNN7EXAMPLE/",
    );
    expect(parsed.searchParams.get("X-Amz-Credential")).toContain(
      "/us-east-1/s3/aws4_request",
    );
    expect(signatureOf(uploadUrl)).toMatch(/^[0-9a-f]{64}$/);

    expect(publicUrl).toBe(
      "https://my-bucket.s3.us-east-1.amazonaws.com/uploads/user_1/photo.png",
    );
    expect(key).toBe("uploads/user_1/photo.png");
  });

  it("signs content-type so a URL cannot be reused for another type", async () => {
    const { uploadUrl } = await createPresignedUploadUrl(BASE_OPTIONS);
    expect(new URL(uploadUrl).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-type;host",
    );
  });

  it("produces a different signature when only the content type changes", async () => {
    // This is the property that makes the server-side MIME allowlist meaningful:
    // a URL issued for a PNG must not authorise an SVG upload.
    const png = await createPresignedUploadUrl(BASE_OPTIONS);
    const svg = await createPresignedUploadUrl({
      ...BASE_OPTIONS,
      contentType: "image/svg+xml",
    });

    expect(signatureOf(png.uploadUrl)).not.toBe(signatureOf(svg.uploadUrl));
  });

  it("defaults the expiry to one hour and honours an override", async () => {
    const def = await createPresignedUploadUrl(BASE_OPTIONS);
    expect(new URL(def.uploadUrl).searchParams.get("X-Amz-Expires")).toBe(
      "3600",
    );

    const short = await createPresignedUploadUrl({
      ...BASE_OPTIONS,
      expiresIn: 60,
    });
    expect(new URL(short.uploadUrl).searchParams.get("X-Amz-Expires")).toBe(
      "60",
    );
  });

  it("percent-encodes each key segment without escaping the separators", async () => {
    const { uploadUrl, publicUrl } = await createPresignedUploadUrl({
      ...BASE_OPTIONS,
      key: "uploads/user 1/my photo.png",
    });

    expect(new URL(uploadUrl).pathname).toBe(
      "/uploads/user%201/my%20photo.png",
    );
    expect(publicUrl).toContain("/uploads/user%201/my%20photo.png");
  });

  it("is deterministic for a fixed set of inputs within the same second", async () => {
    const [a, b] = await Promise.all([
      createPresignedUploadUrl(BASE_OPTIONS),
      createPresignedUploadUrl(BASE_OPTIONS),
    ]);

    expect(signatureOf(a.uploadUrl)).toBe(signatureOf(b.uploadUrl));
  });
});
