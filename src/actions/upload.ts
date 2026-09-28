"use server";

import { z } from "zod";
import { ActionError } from "@/lib/actions/result";
import { defineAuthedAction } from "@/lib/actions/define-authed-action";
import { createPresignedUploadUrl } from "@/lib/s3";
import type { PresignedUploadResult, S3Target } from "@/lib/s3";
import {
  ALLOWED_MIME_TYPES,
  buildQuarantineKey,
  MAX_FILE_SIZE_BYTES,
  parseObjectKey,
  QUARANTINE_PREFIX,
} from "@/lib/uploads/policy";
import type { AllowedMimeType } from "@/lib/uploads/policy";
import { resolveUploadScanner } from "@/lib/uploads/scan";
import { verifyUploadedObject, REJECTION_MESSAGES } from "@/lib/uploads/verify";
import { serverEnv } from "@/lib/env/server";

/**
 * The two halves of an upload: mint a URL, then verify what arrived through it.
 *
 * ## Why there are two actions now
 *
 * There was one, and it was the whole of the validation. It checked a content
 * type and a size that the caller had supplied, signed the type into a presigned
 * PUT, and handed back the object's public URL — at which point the upload had
 * not happened yet and nothing in the system would ever look at the bytes. Every
 * check was on a claim, and the claims were free.
 *
 * Two things follow from the direct-to-S3 shape, and they are what this split is
 * for. The browser writes the object, so the only way to check its *contents* is
 * to read them back afterwards; and if the URL a caller ends up with is only
 * issued after that read, then an unverified object is never addressable. Hence a
 * `quarantine/` key the presign writes to, and `finalizeUploadAction` as the only
 * thing that returns a URL.
 *
 * ## What the schema already fixed, and what it could not
 *
 * The schema on the presign input predates this item and stays as it was: it is
 * what stopped `filename` reaching the S3 key (an extension of
 * `"a.png/../../other-user/evil"` walked straight out of the caller's prefix, the
 * only access control in that template) and what stopped `undefined`, `null` and
 * `NaN` sailing past a bare `>` against the size limit. The extension still comes
 * from the content type rather than the filename, so no caller string reaches the
 * key at all.
 *
 * What a schema cannot do is tell whether a file is what it says it is, and that
 * is the gap this item closes. `contentType` is still validated against the
 * allowlist here — it decides the `Content-Type` S3 stores, so it has to be — but
 * it is no longer the last word on anything: `verifyUploadedObject` compares the
 * stored type with the object's actual leading bytes, re-measures its length, and
 * runs the scan, and only then is the object copied to a readable key.
 */

const presignedUrlSchema = z.object({
  /**
   * Bounded and required, but deliberately not pattern-matched: the key is not
   * built from it, so the only job left is to reject something that is not a
   * filename at all.
   */
  filename: z
    .string()
    .min(1, "A filename is required")
    .max(255, "Filename is too long"),
  /**
   * `z.string().pipe(z.enum(...))` rather than the bare `z.enum(...)`, and the
   * difference is at the *call site*: the input type of a bare enum is the
   * union, so the caller would have to prove the value is one of the accepted
   * strings before it can be checked. The only caller is `ImageUpload`, which
   * passes `file.type` — a browser-supplied string that is exactly the thing
   * this schema exists to constrain, and that a client-side cast would have to
   * lie about. The pipe accepts a `string` and hands the handler the narrowed
   * type, which is the honest shape of "send me anything, I will decide".
   */
  contentType: z.string().pipe(
    z.enum(
      ALLOWED_MIME_TYPES as unknown as [AllowedMimeType, ...AllowedMimeType[]],
      {
        message: "File type not allowed. Accepted: JPEG, PNG, WebP and GIF.",
      },
    ),
  ),
  /**
   * Now load-bearing rather than advisory. It is signed into the upload URL as
   * `content-length`, so S3 refuses a PUT of any other length, and
   * `verifyUploadedObject` re-measures the stored object against it. Before this
   * item it was validated and then dropped, which made the 5 MB ceiling a number
   * three layers agreed on and nothing enforced.
   *
   * `.positive()` rather than `.nonnegative()`: a zero-byte object cannot carry
   * any format's signature, so it would be minted a URL and then refused by the
   * sniffer — better to refuse it here, where the caller gets a sentence about
   * the file rather than one about verification.
   */
  sizeBytes: z
    .number()
    .int("File size must be a whole number of bytes")
    .positive("File size must be greater than zero")
    .max(MAX_FILE_SIZE_BYTES, "File exceeds the 5 MB size limit."),
});

export type PresignedUrlInput = z.input<typeof presignedUrlSchema>;

/**
 * The finalize input.
 *
 * `key` is bounded and shape-checked by `parseObjectKey` in the handler rather
 * than by a regex here, so that the pattern lives with the function that mints
 * keys and the two cannot drift. The length bound is here because it is the
 * cheapest possible rejection of a megabyte of string.
 */
const finalizeSchema = z.object({
  key: z.string().min(1, "An upload key is required").max(512),
  sizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
});

export type FinalizeUploadInput = z.input<typeof finalizeSchema>;

export interface FinalizedUpload {
  publicUrl: string;
  key: string;
  type: string;
  sizeBytes: number;
  /**
   * Whether a scanner actually returned a verdict. Surfaced to the caller, not
   * just logged: a client that wants to hold an image back from a public profile
   * until it has been scanned needs to be able to tell, and a deployment with no
   * scanner configured should not be able to pretend otherwise.
   */
  scanned: boolean;
}

/**
 * The bucket configuration, or an `ActionError` naming the missing piece.
 *
 * Shared by both actions because both need it and because "uploads are not
 * configured" should be one sentence in one place — a finalize that failed
 * differently from a presign on the same missing variable would read as a bug in
 * the upload rather than as a gap in the environment.
 */
function requireBucket(): Omit<S3Target, "key"> {
  if (
    !serverEnv.AWS_ACCESS_KEY_ID ||
    !serverEnv.AWS_SECRET_ACCESS_KEY ||
    !serverEnv.S3_BUCKET_NAME
  ) {
    throw new ActionError("File uploads are not configured on this server.");
  }

  return {
    bucket: serverEnv.S3_BUCKET_NAME,
    region: serverEnv.AWS_REGION,
    accessKeyId: serverEnv.AWS_ACCESS_KEY_ID,
    secretAccessKey: serverEnv.AWS_SECRET_ACCESS_KEY,
  };
}

export const getPresignedUploadUrlAction = defineAuthedAction({
  name: "getPresignedUploadUrl",
  input: presignedUrlSchema,
  unauthenticatedMessage: "You must be signed in to upload files.",
  handler: async ({ input, user }): Promise<PresignedUploadResult> => {
    const bucket = requireBucket();

    return createPresignedUploadUrl({
      ...bucket,
      key: buildQuarantineKey({
        userId: user.id,
        contentType: input.contentType,
      }),
      contentType: input.contentType,
      contentLength: input.sizeBytes,
    });
  },
});

export const finalizeUploadAction = defineAuthedAction({
  name: "finalizeUpload",
  input: finalizeSchema,
  unauthenticatedMessage: "You must be signed in to upload files.",
  handler: async ({ input, user }): Promise<FinalizedUpload> => {
    const bucket = requireBucket();

    // The access-control check, and the reason this handler cannot be thinned
    // any further. `key` arrives from the caller: without this, a signed-in user
    // could pass another user's quarantine key and have the server read it,
    // promote it to a public URL under that user's prefix, and hand them the
    // URL — using this application's own credentials to publish someone else's
    // unverified object. Both halves are needed, the prefix *and* the id: a
    // shape check alone accepts `quarantine/<someone-else>/…`.
    const parsed = parseObjectKey(input.key);
    if (
      !parsed ||
      parsed.prefix !== QUARANTINE_PREFIX ||
      parsed.userId !== user.id
    ) {
      throw new ActionError("That upload is not yours to complete.");
    }

    const outcome = await verifyUploadedObject(
      {
        target: bucket,
        quarantineKey: input.key,
        declaredSizeBytes: input.sizeBytes,
      },
      { scanner: resolveUploadScanner(), fetchImpl: fetch },
    );

    if (!outcome.accepted) {
      throw new ActionError(REJECTION_MESSAGES[outcome.reason]);
    }

    return {
      publicUrl: outcome.publicUrl,
      key: outcome.key,
      type: outcome.type,
      sizeBytes: outcome.sizeBytes,
      scanned: outcome.scanned,
    };
  },
});
