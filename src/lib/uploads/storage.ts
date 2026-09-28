/**
 * The three S3 operations verification needs, over `fetch` and a presigned URL.
 *
 * This module is the reason `docs/owasp-top-10.md` gained a row under A10 and
 * lost its gap there. Until now this application never fetched what was
 * uploaded — the browser PUT straight to the bucket and the server only ever
 * signed a URL — and the checklist said in as many words that a content-sniffing
 * or antivirus step reading the object back would become a new outbound call
 * site. It is this one.
 *
 * What makes it a safe one is that nothing about the request comes from a
 * caller. The host is derived from `S3_BUCKET_NAME` and `AWS_REGION`, both from
 * the validated environment. The key is checked by `parseObjectKey` and its user
 * segment compared with the session's own id before anything here is called, so
 * a caller cannot aim the readback at another user's object, let alone at
 * another host — there is no place in the URL for a hostname to arrive.
 */
import "server-only";

import {
  createPresignedCopyUrl,
  createPresignedDeleteUrl,
  createPresignedReadUrl,
} from "@/lib/s3";
import type { S3Target } from "@/lib/s3";
import { logWarn } from "@/lib/logging/logger";
import { SNIFF_BYTE_COUNT } from "@/lib/uploads/sniff";

/**
 * What a bounded read of an object's head tells us.
 *
 * `totalBytes` is the fact the size cap is actually enforced against. The
 * declared `sizeBytes` is a caller's word, the signed `content-length` is what
 * S3 was told to require, and this is what is in the bucket — three numbers that
 * should agree, of which only the third is evidence.
 *
 * `storedContentType` is the other measured fact, and the sharper one: it is the
 * `Content-Type` S3 recorded on the PUT, which is the header it will serve these
 * bytes back with. Checking the sniffed type against *this*, rather than against
 * the type the caller re-declares on finalize, is what makes the check mean
 * something — the question a browser will eventually ask is "what did S3 say
 * this was", and the answer is stored here.
 */
export interface ObjectHead {
  bytes: Uint8Array;
  totalBytes: number;
  storedContentType: string;
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

/**
 * Parses the object's full length out of a `Content-Range`.
 *
 * `bytes 0-511/12345` → `12345`. The total after the slash is the whole object's
 * size, which a range request is the cheapest way to learn: a separate HEAD
 * would be a second round trip for a number this response already carries.
 *
 * `*` as the total is legal in the grammar (an unknown length) and is not
 * something S3 sends for a stored object, so it returns `null` and the caller
 * treats an unparseable range as a failure rather than as a zero.
 */
export function parseContentRangeTotal(value: string | null): number | null {
  if (!value) return null;
  const match = /^bytes\s+\d+-\d+\/(\d+)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]);
}

/**
 * Reads the first `SNIFF_BYTE_COUNT` bytes of an object, and its real length.
 *
 * The range is what keeps a 5 MB object from being pulled into a Server Action's
 * memory to look at eight bytes of it. `fetchImpl` is injected for testing, the
 * same seam `@/lib/vitals/sink` and `@/lib/uploads/scan` use.
 *
 * A `200` instead of a `206` is handled rather than rejected: a bucket, proxy or
 * S3-compatible implementation may ignore `Range` and answer with the whole
 * object. The response is then bounded on this side — `slice` takes the header
 * bytes and the rest is dropped — and the length comes from `Content-Length`,
 * which for a `200` *is* the whole object.
 */
export async function readObjectHead(
  target: S3Target,
  fetchImpl: typeof fetch = fetch,
): Promise<ObjectHead> {
  const url = await createPresignedReadUrl(target);

  const response = await fetchImpl(url, {
    method: "GET",
    headers: { range: `bytes=0-${SNIFF_BYTE_COUNT - 1}` },
  });

  if (!response.ok) {
    throw new StorageError(
      `could not read the uploaded object back (HTTP ${response.status})`,
    );
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer).slice(0, SNIFF_BYTE_COUNT);

  const rangeTotal = parseContentRangeTotal(
    response.headers.get("content-range"),
  );
  const contentLength = Number(response.headers.get("content-length"));

  // A 206 carries the object's length after the slash in `Content-Range`; its
  // `Content-Length` is the length of the *slice*, which is why that header is
  // only trusted when the response was not a partial one.
  const totalBytes =
    rangeTotal ??
    (response.status === 206 || !Number.isFinite(contentLength)
      ? null
      : contentLength);

  if (totalBytes === null) {
    throw new StorageError(
      "the object's length could not be established: the response carried " +
        "neither a parseable Content-Range nor, on a non-partial response, a " +
        "Content-Length. Accepting it would mean enforcing the size cap " +
        "against a number nobody measured.",
    );
  }

  return {
    bytes,
    totalBytes,
    storedContentType: response.headers.get("content-type") ?? "",
  };
}

/**
 * Copies an object to another key of the same bucket, replacing its type.
 *
 * Used to promote a verified object out of `quarantine/` into `uploads/`. The
 * `contentType` passed is the *sniffed* one, so the object that becomes readable
 * is labelled with what its bytes are rather than with what its uploader said.
 */
export async function copyObject(
  options: S3Target & { sourceKey: string; contentType: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = await createPresignedCopyUrl(options);

  const response = await fetchImpl(url, {
    method: "PUT",
    headers: {
      "x-amz-copy-source": `/${options.bucket}/${options.sourceKey}`,
      "x-amz-metadata-directive": "REPLACE",
      "content-type": options.contentType,
    },
  });

  if (!response.ok) {
    throw new StorageError(
      `could not promote the uploaded object (HTTP ${response.status})`,
    );
  }

  // S3's CopyObject answers 200 with an *error* document for a failure that
  // happens after the response has begun — a well-known trap, since the status
  // line has already gone out by then. The body is small enough to read.
  const body = await response.text();
  if (/<Error>/.test(body)) {
    throw new StorageError(
      "S3 answered 200 with an error document for the copy, which is how it " +
        "reports a failure that happened after the response headers were sent.",
    );
  }
}

/**
 * Deletes an object, and never throws.
 *
 * Deletion is cleanup on a path that has already decided to refuse an upload,
 * and the caller has nothing useful to do with a failure: reporting "your file
 * was rejected, and also we could not delete it" helps nobody, and throwing here
 * would turn a clean rejection into a server fault. So a failure is logged and
 * swallowed, and the object is left in `quarantine/` — which is not public, and
 * is the prefix a lifecycle rule should be expiring anyway. `docs/uploads.md`
 * has that rule.
 */
export async function deleteObject(
  target: S3Target,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const url = await createPresignedDeleteUrl(target);
    const response = await fetchImpl(url, { method: "DELETE" });

    if (!response.ok) {
      logWarn("upload.quarantine_delete_failed", {
        key: target.key,
        status: response.status,
      });
      return false;
    }

    return true;
  } catch (error) {
    logWarn("upload.quarantine_delete_failed", {
      key: target.key,
      error,
    });
    return false;
  }
}
