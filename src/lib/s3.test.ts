import { describe, it, expect } from "vitest";
import {
  createPresignedCopyUrl,
  createPresignedDeleteUrl,
  createPresignedReadUrl,
  createPresignedUploadUrl,
  encodeKey,
  objectUrl,
  presignS3Url,
} from "./s3";

// Obviously-fake credentials, and deliberately not AWS's documentation example
// pair: that pair is credential-*shaped*, so a secret scanner flags it on sight
// and a reviewer then has to know the string to dismiss the finding. Nothing here
// needs a well-formed key — SigV4 is HMAC over whatever bytes it is given, and
// these tests assert the canonical request rather than talking to S3.
const BASE_OPTIONS = {
  bucket: "my-bucket",
  key: "quarantine/user_1/photo.png",
  region: "us-east-1",
  accessKeyId: "mock-access-key-id",
  secretAccessKey: "mock-secret-access-key",
  contentType: "image/png",
  contentLength: 4096,
};

function signatureOf(url: string): string {
  return new URL(url).searchParams.get("X-Amz-Signature") ?? "";
}

function signedHeadersOf(url: string): string {
  return new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "";
}

describe("createPresignedUploadUrl", () => {
  it("builds a SigV4 PUT URL against the bucket's virtual host", async () => {
    const { uploadUrl, key } = await createPresignedUploadUrl(BASE_OPTIONS);
    const parsed = new URL(uploadUrl);

    expect(parsed.host).toBe("my-bucket.s3.us-east-1.amazonaws.com");
    expect(parsed.pathname).toBe("/quarantine/user_1/photo.png");
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-Credential")).toContain(
      "mock-access-key-id/",
    );
    expect(parsed.searchParams.get("X-Amz-Credential")).toContain(
      "/us-east-1/s3/aws4_request",
    );
    expect(signatureOf(uploadUrl)).toMatch(/^[0-9a-f]{64}$/);

    expect(key).toBe("quarantine/user_1/photo.png");
  });

  it("returns no URL the uploaded object can be read from", async () => {
    // The result used to carry `publicUrl`, and handing it back was the shape of
    // the problem rather than a detail of it: a public URL for an object whose
    // bytes nothing had looked at, issued before the upload had even happened.
    // `finalizeUploadAction` is the only thing that returns one now.
    const result = await createPresignedUploadUrl(BASE_OPTIONS);

    expect(Object.keys(result).sort()).toEqual(["key", "uploadUrl"]);
    for (const value of Object.values(result)) {
      expect(value).not.toMatch(/^https:\/\/[^?]+$/);
    }
  });

  it("signs content-length as well as content-type", async () => {
    // The size cap, made binding. Every header named here must arrive with the
    // value that was signed or S3 answers SignatureDoesNotMatch, so a caller
    // cannot PUT more bytes than it declared.
    const { uploadUrl } = await createPresignedUploadUrl(BASE_OPTIONS);
    expect(signedHeadersOf(uploadUrl)).toBe("content-length;content-type;host");
  });

  it("produces a different signature when only the length changes", async () => {
    // The property the previous signature did not have. With `content-type;host`
    // signed over an UNSIGNED-PAYLOAD, these two URLs were byte-identical: one
    // minted for a 4 KB upload authorised a 5 GB one.
    const small = await createPresignedUploadUrl(BASE_OPTIONS);
    const large = await createPresignedUploadUrl({
      ...BASE_OPTIONS,
      contentLength: 5 * 1024 * 1024,
    });

    expect(signatureOf(small.uploadUrl)).not.toBe(signatureOf(large.uploadUrl));
  });

  it("produces a different signature when only the content type changes", async () => {
    // This is the property that makes the server-side MIME allowlist meaningful:
    // a URL issued for a PNG must not authorise a GIF upload.
    const png = await createPresignedUploadUrl(BASE_OPTIONS);
    const gif = await createPresignedUploadUrl({
      ...BASE_OPTIONS,
      contentType: "image/gif",
    });

    expect(signatureOf(png.uploadUrl)).not.toBe(signatureOf(gif.uploadUrl));
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
    const { uploadUrl } = await createPresignedUploadUrl({
      ...BASE_OPTIONS,
      key: "quarantine/user 1/my photo.png",
    });

    expect(new URL(uploadUrl).pathname).toBe(
      "/quarantine/user%201/my%20photo.png",
    );
  });

  it("is deterministic for a fixed set of inputs within the same second", async () => {
    const [a, b] = await Promise.all([
      createPresignedUploadUrl(BASE_OPTIONS),
      createPresignedUploadUrl(BASE_OPTIONS),
    ]);

    expect(signatureOf(a.uploadUrl)).toBe(signatureOf(b.uploadUrl));
  });
});

describe("presignS3Url", () => {
  it("sorts signed headers by lowercased name regardless of the order given", async () => {
    // Canonical headers must be sorted or the signature is simply wrong, which
    // reads as a credentials problem. Sorting here rather than trusting callers
    // to pass an ordered object is what makes that unreachable.
    const url = await presignS3Url({
      ...BASE_OPTIONS,
      method: "PUT",
      headers: {
        "x-amz-copy-source": "/my-bucket/quarantine/user_1/a.png",
        "content-type": "image/png",
      },
    });

    expect(signedHeadersOf(url)).toBe("content-type;host;x-amz-copy-source");
  });

  it("carries the method into the signature", async () => {
    const get = await presignS3Url({ ...BASE_OPTIONS, method: "GET" });
    const del = await presignS3Url({ ...BASE_OPTIONS, method: "DELETE" });

    expect(signatureOf(get)).not.toBe(signatureOf(del));
  });
});

describe("createPresignedReadUrl", () => {
  it("signs host only, leaving Range unsigned", async () => {
    // Range is deliberately not signed: signing it would bind the URL to one
    // window of the object, and a caller who can GET the object can GET all of
    // it anyway. What bounds the transfer is `readObjectHead` reading a bounded
    // number of bytes.
    const url = await createPresignedReadUrl(BASE_OPTIONS);

    expect(signedHeadersOf(url)).toBe("host");
    expect(url).toContain("/quarantine/user_1/photo.png?");
  });
});

describe("createPresignedDeleteUrl", () => {
  it("presigns a DELETE distinct from the read of the same key", async () => {
    const read = await createPresignedReadUrl(BASE_OPTIONS);
    const remove = await createPresignedDeleteUrl(BASE_OPTIONS);

    expect(signatureOf(read)).not.toBe(signatureOf(remove));
    expect(signedHeadersOf(remove)).toBe("host");
  });
});

describe("createPresignedCopyUrl", () => {
  it("signs the copy source, so a promotion URL cannot be redirected", async () => {
    const url = await createPresignedCopyUrl({
      ...BASE_OPTIONS,
      key: "uploads/user_1/photo.png",
      sourceKey: "quarantine/user_1/photo.png",
    });

    expect(signedHeadersOf(url)).toBe(
      "content-type;host;x-amz-copy-source;x-amz-metadata-directive",
    );
    expect(new URL(url).pathname).toBe("/uploads/user_1/photo.png");
  });

  it("produces a different signature for a different source key", async () => {
    // Without the source signed, one promotion URL would publish any object in
    // the bucket the holder could name.
    const mine = await createPresignedCopyUrl({
      ...BASE_OPTIONS,
      key: "uploads/user_1/photo.png",
      sourceKey: "quarantine/user_1/photo.png",
    });
    const theirs = await createPresignedCopyUrl({
      ...BASE_OPTIONS,
      key: "uploads/user_1/photo.png",
      sourceKey: "quarantine/user_2/photo.png",
    });

    expect(signatureOf(mine)).not.toBe(signatureOf(theirs));
  });

  it("percent-encodes the source key, which S3 parses rather than accepts raw", async () => {
    const url = await createPresignedCopyUrl({
      ...BASE_OPTIONS,
      key: "uploads/user_1/my photo.png",
      sourceKey: "quarantine/user_1/my photo.png",
    });

    // The signed value is not in the URL, so this asserts the encoder the
    // header is built from instead — an unencoded space there is a 404 on an
    // object that exists.
    expect(encodeKey("quarantine/user_1/my photo.png")).toBe(
      "quarantine/user_1/my%20photo.png",
    );
    expect(new URL(url).pathname).toBe("/uploads/user_1/my%20photo.png");
  });
});

describe("objectUrl", () => {
  it("builds the unsigned URL an object is served from", () => {
    expect(
      objectUrl({
        bucket: "my-bucket",
        region: "eu-west-2",
        key: "uploads/user_1/photo.png",
      }),
    ).toBe(
      "https://my-bucket.s3.eu-west-2.amazonaws.com/uploads/user_1/photo.png",
    );
  });

  it("carries no query string, so it cannot be mistaken for a signed URL", () => {
    const url = objectUrl({
      bucket: "my-bucket",
      region: "us-east-1",
      key: "uploads/user_1/photo.png",
    });

    expect(url).not.toContain("?");
  });
});
