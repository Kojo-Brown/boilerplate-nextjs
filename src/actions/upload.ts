"use server";

import { z } from "zod";
import { ActionError } from "@/lib/actions/result";
import { defineAuthedAction } from "@/lib/actions/define-authed-action";
import {
  ALLOWED_MIME_TYPES,
  createPresignedUploadUrl,
  MAX_FILE_SIZE_BYTES,
} from "@/lib/s3";
import type { AllowedMimeType, PresignedUploadResult } from "@/lib/s3";
import { env } from "@/lib/env";

/**
 * Mints a presigned PUT URL for one image.
 *
 * ## What the schema replaced
 *
 * This action declared `input: PresignedUrlInput` and validated none of it. The
 * three fields were TypeScript's word, which a caller POSTing to a
 * `"use server"` export does not have to keep, and two of them were load-bearing:
 *
 *   - `filename` reached `filename.split(".").pop() ?? "bin"`, and the result
 *     was interpolated straight into the S3 key. A `filename` of
 *     `"a.png/../../other-user/evil"` produced an extension containing slashes
 *     and `..`, so the key left the caller's `uploads/<id>/` prefix — the one
 *     thing in that template that was doing any access control. A `filename`
 *     that was not a string at all threw a `TypeError` out of the action.
 *   - `sizeBytes` was compared with `>` against `MAX_FILE_SIZE_BYTES`. A string
 *     `"6000000"` compares as a number and would have been caught, but
 *     `undefined`, `null` and `NaN` all compare `false` and sailed through the
 *     limit.
 *
 * The extension is now derived from the *content type* rather than the
 * filename. The content type is checked against the allowlist and signed into
 * the presigned URL (see `createPresignedUploadUrl`), so it is the field that
 * is actually constrained; taking the extension from it means no caller string
 * reaches the key at all, which is a stronger property than sanitising one.
 * `filename` survives only as something to validate and log — nothing is built
 * from it.
 */

/** The extension written into the key for each type we accept. */
const EXTENSION_BY_MIME_TYPE: Record<AllowedMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

const presignedUrlSchema = z.object({
  /**
   * Bounded and required, but deliberately not pattern-matched: the key is no
   * longer built from it, so the only job left is to reject something that is
   * not a filename at all.
   */
  filename: z
    .string()
    .min(1, "A filename is required")
    .max(255, "Filename is too long"),
  /**
   * `z.string().pipe(z.enum(...))` rather than the bare `z.enum(...)`, and the
   * difference is at the *call site*: the input type of a bare enum is the
   * union, so the caller would have to prove the value is one of five strings
   * before it can be checked. The only caller is `ImageUpload`, which passes
   * `file.type` — a browser-supplied string that is exactly the thing this
   * schema exists to constrain, and that a client-side cast would have to lie
   * about. The pipe accepts a `string` and hands the handler the narrowed type,
   * which is the honest shape of "send me anything, I will decide".
   */
  contentType: z.string().pipe(
    z.enum(ALLOWED_MIME_TYPES as [AllowedMimeType, ...AllowedMimeType[]], {
      message: "File type not allowed. Accepted: JPEG, PNG, WebP, GIF, SVG.",
    }),
  ),
  sizeBytes: z
    .number()
    .int("File size must be a whole number of bytes")
    .nonnegative("File size must not be negative")
    .max(MAX_FILE_SIZE_BYTES, "File exceeds the 5 MB size limit."),
});

export type PresignedUrlInput = z.input<typeof presignedUrlSchema>;

export const getPresignedUploadUrlAction = defineAuthedAction({
  name: "getPresignedUploadUrl",
  input: presignedUrlSchema,
  unauthenticatedMessage: "You must be signed in to upload files.",
  handler: async ({ input, user }): Promise<PresignedUploadResult> => {
    if (
      !env.AWS_ACCESS_KEY_ID ||
      !env.AWS_SECRET_ACCESS_KEY ||
      !env.S3_BUCKET_NAME
    ) {
      throw new ActionError("File uploads are not configured on this server.");
    }

    const extension = EXTENSION_BY_MIME_TYPE[input.contentType];
    const key = `uploads/${user.id}/${Date.now()}-${crypto.randomUUID()}.${extension}`;

    return createPresignedUploadUrl({
      bucket: env.S3_BUCKET_NAME,
      key,
      region: env.AWS_REGION,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      contentType: input.contentType,
    });
  },
});
