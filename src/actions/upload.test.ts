import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as AuthModule from "@/auth";
import type * as S3Module from "@/lib/s3";

// Mocks must be defined before importing the module under test
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/env", () => ({
  env: {
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    AWS_REGION: "us-east-1",
    S3_BUCKET_NAME: "my-bucket",
  },
}));
vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof S3Module>();
  return {
    ...actual,
    createPresignedUploadUrl: vi.fn(),
  };
});

const { getPresignedUploadUrlAction } = await import("@/actions/upload");
const { auth } = await import("@/auth");
const { createPresignedUploadUrl } = await import("@/lib/s3");
const { env } = await import("@/lib/env");

const mockAuth = vi.mocked(auth as typeof AuthModule.auth);
const mockCreatePresignedUrl = vi.mocked(createPresignedUploadUrl);

const FAKE_PRESIGNED: S3Module.PresignedUploadResult = {
  uploadUrl: "https://my-bucket.s3.us-east-1.amazonaws.com/uploads/user_1/abc.png?sig=x",
  publicUrl: "https://my-bucket.s3.us-east-1.amazonaws.com/uploads/user_1/abc.png",
  key: "uploads/user_1/abc.png",
};

beforeEach(() => {
  mockAuth.mockResolvedValue({ user: { id: "user_1", email: "test@example.com" } } as Awaited<
    ReturnType<typeof AuthModule.auth>
  >);
  mockCreatePresignedUrl.mockResolvedValue(FAKE_PRESIGNED);
  // Restore S3 env for each test
  const mutableEnv = env as Record<string, unknown>;
  mutableEnv["AWS_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
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

  it("returns error when file is too large", async () => {
    const result = await getPresignedUploadUrlAction({
      filename: "huge.png",
      contentType: "image/png",
      sizeBytes: 6 * 1024 * 1024,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/5 MB/);
  });

  it("returns presigned URL data on valid input", async () => {
    const result = await getPresignedUploadUrlAction({
      filename: "photo.png",
      contentType: "image/png",
      sizeBytes: 512 * 1024,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.uploadUrl).toContain("my-bucket.s3");
      expect(result.data.publicUrl).toContain("my-bucket.s3");
      expect(result.data.key).toMatch(/^uploads\/user_1\//);
    }
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
