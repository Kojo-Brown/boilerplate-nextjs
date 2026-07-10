"use server";

import { auth } from "@/auth";
import { ok, err } from "@/lib/actions";
import type { ActionResult } from "@/lib/actions";
import { createPresignedUploadUrl, isAllowedMimeType, MAX_FILE_SIZE_BYTES } from "@/lib/s3";
import type { PresignedUploadResult } from "@/lib/s3";
import { env } from "@/lib/env";

export interface PresignedUrlInput {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export async function getPresignedUploadUrlAction(
  input: PresignedUrlInput,
): Promise<ActionResult<PresignedUploadResult>> {
  const session = await auth();
  if (!session?.user?.id) {
    return err("You must be signed in to upload files.");
  }

  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.S3_BUCKET_NAME) {
    return err("File uploads are not configured on this server.");
  }

  const { filename, contentType, sizeBytes } = input;

  if (!isAllowedMimeType(contentType)) {
    return err("File type not allowed. Accepted: JPEG, PNG, WebP, GIF, SVG.");
  }

  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    return err("File exceeds the 5 MB size limit.");
  }

  const ext = filename.split(".").pop() ?? "bin";
  const key = `uploads/${session.user.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const result = await createPresignedUploadUrl({
    bucket: env.S3_BUCKET_NAME,
    key,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    contentType,
  });

  return ok(result);
}
