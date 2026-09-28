import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "next-auth";
import type * as S3Module from "@/lib/s3";
import type * as VerifyModule from "@/lib/uploads/verify";

// Mocks must be defined before importing the module under test
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/env/server", () => ({
  serverEnv: {
    AWS_ACCESS_KEY_ID: "mock-access-key-id",
    AWS_SECRET_ACCESS_KEY: "mock-secret-access-key",
    AWS_REGION: "us-east-1",
    S3_BUCKET_NAME: "my-bucket",
    UPLOAD_SCANNER_URL: undefined,
    UPLOAD_SCANNER_API_KEY: undefined,
  },
}));
vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof S3Module>();
  return {
    ...actual,
    createPresignedUploadUrl: vi.fn(),
  };
});
// Mocked so that these tests are about the action's own two jobs — validating
// input and establishing that the key belongs to the caller — rather than about
// the decision table, which `verify.test.ts` covers against a stubbed network.
vi.mock("@/lib/uploads/verify", async (importOriginal) => {
  const actual = await importOriginal<typeof VerifyModule>();
  return { ...actual, verifyUploadedObject: vi.fn() };
});

const { setRequestHeaders } = await import("@/test/request-headers");
const { ORIGIN_REJECTED_MESSAGE } = await import("@/lib/actions/origin");
const { finalizeUploadAction, getPresignedUploadUrlAction } =
  await import("@/actions/upload");
const { auth } = await import("@/auth");
const { createPresignedUploadUrl } = await import("@/lib/s3");
const { verifyUploadedObject } = await import("@/lib/uploads/verify");
const { serverEnv: env } = await import("@/lib/env/server");

// NextAuth v5's `auth` is overloaded (middleware, route wrapper, bare call).
// `typeof AuthModule.auth` keeps all the overloads, and vi.mocked binds to the
// middleware one — narrowing to the no-argument form fixes the stub types.
const mockAuth = vi.mocked(auth as () => Promise<Session | null>);
const mockCreatePresignedUrl = vi.mocked(createPresignedUploadUrl);
const mockVerify = vi.mocked(verifyUploadedObject);

const FAKE_PRESIGNED: S3Module.PresignedUploadResult = {
  uploadUrl:
    "https://my-bucket.s3.us-east-1.amazonaws.com/quarantine/user_1/abc.png?sig=x",
  key: "quarantine/user_1/abc.png",
};

const UUID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const OWN_KEY = `quarantine/user_1/1767225600000-${UUID}.png`;
const PROMOTED_KEY = `uploads/user_1/1767225600000-${UUID}.png`;

beforeEach(() => {
  // Call history, not implementations — the assertions below include
  // "the signer was never reached", which a previous test's call would satisfy.
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { id: "user_1", email: "test@example.com", role: "USER" },
    expires: "2099-01-01T00:00:00.000Z",
  });
  mockCreatePresignedUrl.mockResolvedValue(FAKE_PRESIGNED);
  mockVerify.mockResolvedValue({
    accepted: true,
    key: PROMOTED_KEY,
    publicUrl: `https://my-bucket.s3.us-east-1.amazonaws.com/${PROMOTED_KEY}`,
    type: "image/png",
    sizeBytes: 4096,
    scanned: true,
  });
  // Restore S3 env for each test
  const mutableEnv = env as Record<string, unknown>;
  mutableEnv["AWS_ACCESS_KEY_ID"] = "mock-access-key-id";
  mutableEnv["S3_BUCKET_NAME"] = "my-bucket";
});

describe("getPresignedUploadUrlAction", () => {
  it("returns error when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const result = await getPresignedUploadUrlAction({
      filename: "photo.png",
      contentType: "image/png",
      sizeBytes: 1024,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/signed in/i);
  });

  it("returns error when S3 env vars are missing", async () => {
    const mutableEnv = env as Record<string, unknown>;
    const savedId = mutableEnv["AWS_ACCESS_KEY_ID"];
    const savedBucket = mutableEnv["S3_BUCKET_NAME"];
    mutableEnv["AWS_ACCESS_KEY_ID"] = undefined;
    mutableEnv["S3_BUCKET_NAME"] = undefined;
    const result = await getPresignedUploadUrlAction({
      filename: "photo.png",
      contentType: "image/png",
      sizeBytes: 1024,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not configured/i);
    mutableEnv["AWS_ACCESS_KEY_ID"] = savedId;
    mutableEnv["S3_BUCKET_NAME"] = savedBucket;
  });

  it("returns error for disallowed MIME type", async () => {
    const result = await getPresignedUploadUrlAction({
      filename: "doc.pdf",
      contentType: "application/pdf",
      sizeBytes: 1024,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not allowed/i);
  });

  it("no longer accepts image/svg+xml", async () => {
    // Removed from the allowlist deliberately: an SVG carrying `<script>` is a
    // well-formed SVG, so no amount of sniffing separates it from a drawing. See
    // the header of `@/lib/uploads/policy`.
    const result = await getPresignedUploadUrlAction({
      filename: "logo.svg",
      contentType: "image/svg+xml",
      sizeBytes: 1024,
    });

    expect(result.success).toBe(false);
    expect(mockCreatePresignedUrl).not.toHaveBeenCalled();
  });

  it("returns error when file is too large", async () => {
    const result = await getPresignedUploadUrlAction({
      filename: "huge.png",
      contentType: "image/png",
      sizeBytes: 6 * 1024 * 1024,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/5 MB/);
  });

  it("returns an upload URL and a quarantine key, and no readable URL", async () => {
    // The shape change this item is about. Nothing here can be used to read the
    // object: an unverified upload has no URL to hand out.
    const result = await getPresignedUploadUrlAction({
      filename: "photo.png",
      contentType: "image/png",
      sizeBytes: 512 * 1024,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data).sort()).toEqual(["key", "uploadUrl"]);
      expect(result.data.key).toMatch(/^quarantine\//);
    }
  });

  it("writes to the quarantine prefix, never straight to the public one", async () => {
    await getPresignedUploadUrlAction({
      filename: "photo.png",
      contentType: "image/png",
      sizeBytes: 512 * 1024,
    });

    const key = mockCreatePresignedUrl.mock.lastCall![0].key;
    expect(key).toMatch(/^quarantine\/user_1\//);
    expect(key).not.toMatch(/^uploads\//);
  });

  it("signs the declared size as content-length, making the cap binding", async () => {
    // Previously `sizeBytes` was validated and then dropped: the URL signed
    // `content-type;host` over an UNSIGNED-PAYLOAD and authorised a PUT of any
    // length at all.
    await getPresignedUploadUrlAction({
      filename: "photo.png",
      contentType: "image/png",
      sizeBytes: 512 * 1024,
    });

    expect(mockCreatePresignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ contentLength: 512 * 1024 }),
    );
  });

  it("never lets the filename escape the caller's prefix", async () => {
    // The regression this schema exists for. `filename` used to reach
    // `filename.split(".").pop()` and be interpolated straight into the key, so
    // an extension containing slashes and `..` walked out of the caller's prefix
    // — the only thing in that template doing any access control.
    for (const filename of [
      "a.png/../../other-user/evil",
      "../../../etc/passwd.png",
      "x.png/../../../../root",
      "shell.png/..%2f..%2fescape",
    ]) {
      const result = await getPresignedUploadUrlAction({
        filename,
        contentType: "image/png",
        sizeBytes: 1024,
      });

      expect(result.success, filename).toBe(true);

      // Asserted against the key handed to the signer, not `result.data.key` —
      // that comes back from the mock and would look right no matter what the
      // action built.
      const key = mockCreatePresignedUrl.mock.lastCall?.[0].key;

      // The key is built from the content type, so nothing from the filename
      // reaches it at all.
      expect(key, filename).toMatch(
        /^quarantine\/user_1\/\d+-[0-9a-f-]{36}\.png$/,
      );
    }
  });

  it("rejects a filename that is not a string", async () => {
    // Previously a `TypeError` out of the action rather than a failure the UI
    // could show: `filename.split` on an object.
    const result = await getPresignedUploadUrlAction({
      filename: {} as unknown as string,
      contentType: "image/png",
      sizeBytes: 1024,
    });

    expect(result.success).toBe(false);
  });

  it("rejects sizes that slipped past a bare `>` comparison", async () => {
    // `undefined > MAX`, `null > MAX` and `NaN > MAX` are all `false`, so every
    // one of these passed the old limit check. Zero is refused too: a zero-byte
    // object cannot carry any format's signature, so it would be minted a URL
    // and then refused by the sniffer.
    for (const sizeBytes of [undefined, null, Number.NaN, -1, 0, 1.5, "1024"]) {
      const result = await getPresignedUploadUrlAction({
        filename: "photo.png",
        contentType: "image/png",
        sizeBytes: sizeBytes as unknown as number,
      });

      expect(result.success, String(sizeBytes)).toBe(false);
    }
  });

  it("refuses a request posted from another origin", async () => {
    setRequestHeaders({
      origin: "https://evil.example",
      host: "localhost:3000",
    });

    const result = await getPresignedUploadUrlAction({
      filename: "photo.png",
      contentType: "image/png",
      sizeBytes: 1024,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe(ORIGIN_REJECTED_MESSAGE);
    expect(mockCreatePresignedUrl).not.toHaveBeenCalled();
  });

  it("delegates to createPresignedUploadUrl with correct config", async () => {
    await getPresignedUploadUrlAction({
      filename: "avatar.webp",
      contentType: "image/webp",
      sizeBytes: 200 * 1024,
    });
    expect(mockCreatePresignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "my-bucket",
        region: "us-east-1",
        contentType: "image/webp",
      }),
    );
  });
});

describe("finalizeUploadAction", () => {
  it("returns error when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await finalizeUploadAction({
      key: OWN_KEY,
      sizeBytes: 4096,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/signed in/i);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("returns the public URL once verification accepts the object", async () => {
    const result = await finalizeUploadAction({
      key: OWN_KEY,
      sizeBytes: 4096,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        publicUrl: `https://my-bucket.s3.us-east-1.amazonaws.com/${PROMOTED_KEY}`,
        key: PROMOTED_KEY,
        type: "image/png",
        sizeBytes: 4096,
        scanned: true,
      });
    }
  });

  it("surfaces whether a scanner actually answered", async () => {
    // A client that wants to hold an image back until it has been scanned needs
    // to be able to tell, and a deployment with no scanner should not be able to
    // pretend otherwise.
    mockVerify.mockResolvedValue({
      accepted: true,
      key: PROMOTED_KEY,
      publicUrl: `https://my-bucket.s3.us-east-1.amazonaws.com/${PROMOTED_KEY}`,
      type: "image/png",
      sizeBytes: 4096,
      scanned: false,
    });

    const result = await finalizeUploadAction({
      key: OWN_KEY,
      sizeBytes: 4096,
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.scanned).toBe(false);
  });

  it("refuses another user's key without reading it", async () => {
    // The check the whole action exists for. Without it a signed-in user could
    // pass someone else's quarantine key and have this server read it, promote it
    // to a public URL under that user's prefix, and hand them the URL — using
    // this application's own credentials to publish another user's unverified
    // object.
    const result = await finalizeUploadAction({
      key: `quarantine/user_2/1767225600000-${UUID}.png`,
      sizeBytes: 4096,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not yours/i);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("refuses a key whose prefix merely starts with the caller's id", async () => {
    // A `startsWith` on the prefix rather than an equality on the segment would
    // accept `quarantine/user_10/…` for `user_1`.
    const result = await finalizeUploadAction({
      key: `quarantine/user_10/1767225600000-${UUID}.png`,
      sizeBytes: 4096,
    });

    expect(result.success).toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("refuses a key that is already public", async () => {
    // Otherwise finalize would re-copy an object over itself, and a caller could
    // aim the copy at an object that is already serving.
    const result = await finalizeUploadAction({
      key: PROMOTED_KEY,
      sizeBytes: 4096,
    });

    expect(result.success).toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("refuses a key that walks out of the caller's prefix", async () => {
    for (const key of [
      `quarantine/user_1/../user_2/1767225600000-${UUID}.png`,
      "quarantine/user_1/../../uploads/user_2/stolen.png",
      `quarantine/user_1/1767225600000-${UUID}.svg`,
      `quarantine/user_1/1767225600000-${UUID}.html`,
      "quarantine/user_1/photo.png",
      "nonsense",
      "",
    ]) {
      const result = await finalizeUploadAction({ key, sizeBytes: 4096 });

      expect(result.success, JSON.stringify(key)).toBe(false);
    }

    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("turns a rejection into the caller-facing message for that reason", async () => {
    mockVerify.mockResolvedValue({
      accepted: false,
      reason: "type-mismatch",
      detail: "leading bytes are a text/html document",
    });

    const result = await finalizeUploadAction({
      key: OWN_KEY,
      sizeBytes: 4096,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/not a JPEG, PNG, WebP or GIF/);
      // The `detail` is for the log, not for the caller: it is a free oracle for
      // whoever is probing the check.
      expect(result.error).not.toContain("text/html");
    }
  });

  it("reports an infected file without describing the match", async () => {
    mockVerify.mockResolvedValue({
      accepted: false,
      reason: "infected",
      detail: 'the scanner matched "Eicar-Test-File".',
    });

    const result = await finalizeUploadAction({
      key: OWN_KEY,
      sizeBytes: 4096,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/security scan/i);
      expect(result.error).not.toContain("Eicar");
    }
  });

  it("returns error when S3 env vars are missing", async () => {
    // The same sentence the presign gives, from the same helper: a finalize that
    // failed differently on the same missing variable would read as a bug in the
    // upload rather than as a gap in the environment.
    const mutableEnv = env as Record<string, unknown>;
    mutableEnv["S3_BUCKET_NAME"] = undefined;

    const result = await finalizeUploadAction({
      key: OWN_KEY,
      sizeBytes: 4096,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not configured/i);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("refuses a size outside the cap before verifying anything", async () => {
    for (const sizeBytes of [0, -1, 1.5, 6 * 1024 * 1024, "4096", null]) {
      const result = await finalizeUploadAction({
        key: OWN_KEY,
        sizeBytes: sizeBytes as unknown as number,
      });

      expect(result.success, String(sizeBytes)).toBe(false);
    }

    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("refuses a request posted from another origin", async () => {
    setRequestHeaders({
      origin: "https://evil.example",
      host: "localhost:3000",
    });

    const result = await finalizeUploadAction({
      key: OWN_KEY,
      sizeBytes: 4096,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe(ORIGIN_REJECTED_MESSAGE);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("passes the bucket, the key and the declared size to verification", async () => {
    await finalizeUploadAction({ key: OWN_KEY, sizeBytes: 4096 });

    expect(mockVerify).toHaveBeenCalledWith(
      {
        target: {
          bucket: "my-bucket",
          region: "us-east-1",
          accessKeyId: "mock-access-key-id",
          secretAccessKey: "mock-secret-access-key",
        },
        quarantineKey: OWN_KEY,
        declaredSizeBytes: 4096,
      },
      expect.objectContaining({ scanner: expect.anything() }),
    );
  });
});
