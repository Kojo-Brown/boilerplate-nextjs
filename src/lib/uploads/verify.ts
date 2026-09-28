/**
 * The order the four checks run in, and what each failure does to the object.
 *
 * `finalizeUploadAction` is a thin wrapper over this: the action resolves a
 * session, validates a key against it and supplies configuration, and everything
 * that decides whether an upload is kept happens here, as a function of injected
 * dependencies. That split is deliberate — the decision table is the part worth
 * testing exhaustively, and a `"use server"` module that reaches for `auth()`,
 * `serverEnv` and the network is the part that makes exhaustive testing painful.
 *
 * ## Order
 *
 * Size, then sniff, then scan. Each step is cheaper than the next and each one
 * makes the next meaningful:
 *
 *   1. **Length.** The first thing measured, because it is the one fact that is
 *      already in the readback's response headers and because a 40 MB object has
 *      nothing to gain from being sniffed. This is the *real* cap: the declared
 *      `sizeBytes` was a caller's word, and the signed `content-length` is what
 *      S3 was told to enforce — a claim about a request this process did not
 *      make and did not see. What is in the bucket is what counts, and if the two
 *      disagree the object is refused and the disagreement logged, because it
 *      means either the signature is not binding what this code believes it binds
 *      or something wrote the key by another route.
 *
 *   2. **Type.** The sniffed type must equal the type S3 *stored*, which is the
 *      header it will serve the bytes with. Not the type re-declared on finalize:
 *      a caller who could pick that could pick a type matching their own bytes
 *      and the check would confirm a fact of their choosing. `storedContentType`
 *      is what a browser will eventually be told, so it is the only side of the
 *      comparison worth having.
 *
 *   3. **Scan.** Last, because it is the only step that leaves the process, and
 *      because there is no reason to pay for it on an object already known to be
 *      the wrong size or the wrong format. Its verdict goes through
 *      `scanAllowsUpload`, which holds the fail-open/fail-closed policy; this
 *      module does not re-decide it.
 *
 * Every refusal deletes the quarantined object, including the infected one —
 * there is no "keep it for analysis" branch, because that is a decision about
 * someone's malware retention policy and the wrong default for a boilerplate is
 * the one that hoards it.
 *
 * ## One audit line per upload, either way
 *
 * An accepted upload logs at `info`, an accepted-but-unscanned one at `warn`, a
 * refusal at `warn` and an infected object at `error`. The `unscanned` line is
 * the one that matters most: a deployment with no `UPLOAD_SCANNER_URL` is a
 * supported state, and the only thing separating "supported" from "forgotten" is
 * that every single upload says so in the log.
 */
import "server-only";

import type { S3Target } from "@/lib/s3";
import { writeLine } from "@/lib/logging/logger";
import { objectUrl } from "@/lib/s3";
import {
  MAX_FILE_SIZE_BYTES,
  parseObjectKey,
  promotedKeyFor,
  QUARANTINE_PREFIX,
} from "@/lib/uploads/policy";
import { checkDeclaredType } from "@/lib/uploads/sniff";
import { scanAllowsUpload } from "@/lib/uploads/scan";
import type { UploadScanner, ScanVerdict } from "@/lib/uploads/scan";
import {
  copyObject,
  deleteObject,
  readObjectHead,
  StorageError,
} from "@/lib/uploads/storage";
import type { ObjectHead } from "@/lib/uploads/storage";

/** Why an upload was refused. One value per check that can fail. */
export type RejectionReason =
  | "too-large"
  | "size-mismatch"
  | "type-mismatch"
  | "infected"
  | "unscannable"
  | "unreadable"
  | "not-promotable";

export type VerificationOutcome =
  | {
      accepted: true;
      /** The public key the object now lives at. */
      key: string;
      publicUrl: string;
      type: string;
      sizeBytes: number;
      scanned: boolean;
    }
  | { accepted: false; reason: RejectionReason; detail: string };

/**
 * Everything the decision needs, injected.
 *
 * `fetchImpl` is threaded through rather than defaulted here so that a test
 * supplying one cannot half-succeed: if a dependency were defaulted, a test that
 * forgot to stub one operation would reach the real `fetch` and fail on a
 * network error that looks like a logic error.
 */
export interface VerifyDependencies {
  scanner: UploadScanner;
  fetchImpl: typeof fetch;
  /** Injected so the audit assertions do not depend on the console. */
  report?: (line: Record<string, unknown>) => void;
}

function defaultReport(line: Record<string, unknown>): void {
  const level = line["level"];
  writeLine(level === "error" || level === "warn" ? level : "info", line);
}

/**
 * Verifies a quarantined object and, if it passes, promotes it.
 *
 * `quarantineKey` must already have been checked against the caller's own
 * identity — this function re-parses it to build the promoted key and to refuse a
 * key in the wrong prefix, but it does not and cannot know whose it is. That
 * check belongs to the action, and gate rule R4 is what keeps it there.
 */
export async function verifyUploadedObject(
  options: {
    target: Omit<S3Target, "key">;
    quarantineKey: string;
    /** What the presign step declared, kept for the audit line only. */
    declaredSizeBytes: number;
  },
  dependencies: VerifyDependencies,
): Promise<VerificationOutcome> {
  const { target, quarantineKey, declaredSizeBytes } = options;
  const { scanner, fetchImpl } = dependencies;
  const report = dependencies.report ?? defaultReport;

  const parsed = parseObjectKey(quarantineKey);
  const publicKey = promotedKeyFor(quarantineKey);

  if (!parsed || parsed.prefix !== QUARANTINE_PREFIX || !publicKey) {
    return reject(
      "not-promotable",
      `"${quarantineKey}" is not a quarantine key this application minted.`,
    );
  }

  const quarantineTarget: S3Target = { ...target, key: quarantineKey };

  let head: ObjectHead;
  try {
    head = await readObjectHead(quarantineTarget, fetchImpl);
  } catch (error) {
    // Nothing is deleted here: an object that could not be read is an object
    // whose state is unknown, and issuing a delete for a key whose read just
    // failed is as likely to be a no-op as a cleanup. The lifecycle rule on
    // `quarantine/` is what collects it.
    const detail =
      error instanceof StorageError
        ? error.message
        : `unexpected failure reading the object back: ${
            error instanceof Error ? error.message : String(error)
          }`;
    report({
      event: "upload.rejected",
      level: "warn",
      reason: "unreadable",
      key: quarantineKey,
      detail,
    });
    return { accepted: false, reason: "unreadable", detail };
  }

  // 1 — length, measured.
  if (head.totalBytes > MAX_FILE_SIZE_BYTES) {
    await deleteObject(quarantineTarget, fetchImpl);
    return reject(
      "too-large",
      `the stored object is ${head.totalBytes} bytes, over the ` +
        `${MAX_FILE_SIZE_BYTES}-byte limit.`,
    );
  }

  if (head.totalBytes !== declaredSizeBytes) {
    // Not merely pedantic. `content-length` is signed into the upload URL, so
    // S3 should have refused a PUT of any other length: a mismatch means that
    // binding is not doing what this code believes it does, or the object was
    // written by something other than the URL this application minted. Either
    // one invalidates the size cap, so the object goes.
    await deleteObject(quarantineTarget, fetchImpl);
    return reject(
      "size-mismatch",
      `the stored object is ${head.totalBytes} bytes but the upload was ` +
        `signed for ${declaredSizeBytes}. The signed content-length should ` +
        `have made that impossible.`,
    );
  }

  // 2 — type, sniffed and compared with what S3 will serve.
  const sniff = checkDeclaredType(head.bytes, head.storedContentType);
  if (!sniff.agrees) {
    await deleteObject(quarantineTarget, fetchImpl);
    return reject(
      "type-mismatch",
      `S3 stored this object as "${sniff.declared}" and will serve it with ` +
        `that header, but its leading bytes are ` +
        `${sniff.detected === null ? "not a format we accept" : `a ${sniff.detected}`}.`,
    );
  }

  // 3 — scan.
  const verdict: ScanVerdict = await scanner.scan({
    bucket: target.bucket,
    key: quarantineKey,
    declaredType: sniff.type,
    sizeBytes: head.totalBytes,
  });

  if (!scanAllowsUpload(verdict, scanner.requirement)) {
    await deleteObject(quarantineTarget, fetchImpl);

    const infected = verdict.status === "infected";
    const detail = infected
      ? `the scanner matched "${verdict.signature}".`
      : `the scanner did not return a verdict (${
          verdict.status === "unavailable" ? verdict.reason : verdict.status
        }), and a configured scanner is required to.`;

    report({
      event: "upload.rejected",
      level: infected ? "error" : "warn",
      reason: infected ? "infected" : "unscannable",
      key: quarantineKey,
      scanner: scanner.name,
      detail,
    });

    return {
      accepted: false,
      reason: infected ? "infected" : "unscannable",
      detail,
    };
  }

  // Promote, then remove the quarantine copy. In that order: a failed copy
  // leaves the object where it was rather than deleting the only copy of
  // something that passed every check.
  try {
    await copyObject(
      {
        ...target,
        key: publicKey,
        sourceKey: quarantineKey,
        contentType: sniff.type,
      },
      fetchImpl,
    );
  } catch (error) {
    const detail =
      error instanceof StorageError
        ? error.message
        : `unexpected failure promoting the object: ${
            error instanceof Error ? error.message : String(error)
          }`;
    report({
      event: "upload.rejected",
      level: "warn",
      reason: "not-promotable",
      key: quarantineKey,
      detail,
    });
    return { accepted: false, reason: "not-promotable", detail };
  }

  await deleteObject(quarantineTarget, fetchImpl);

  const scanned = verdict.status === "clean";
  report({
    event: "upload.accepted",
    level: scanned ? "info" : "warn",
    key: publicKey,
    type: sniff.type,
    sizeBytes: head.totalBytes,
    scanner: scanner.name,
    // The field a log search for "what went into the bucket without being
    // scanned" runs on. Present and `false` rather than absent, so the query is
    // an equality rather than a missing-key test.
    scanned,
  });

  return {
    accepted: true,
    key: publicKey,
    publicUrl: objectUrl({ ...target, key: publicKey }),
    type: sniff.type,
    sizeBytes: head.totalBytes,
    scanned,
  };

  function reject(
    reason: RejectionReason,
    detail: string,
  ): VerificationOutcome {
    report({
      event: "upload.rejected",
      level: "warn",
      reason,
      key: quarantineKey,
      detail,
    });
    return { accepted: false, reason, detail };
  }
}

/**
 * What the caller is told, per reason.
 *
 * Separate from the `detail` in the audit line, and less specific on purpose.
 * "the stored object is 7340032 bytes" and "its leading bytes are a GIF" are
 * useful to whoever reads the log and are a free oracle for whoever is probing
 * the check; the browser gets the sentence that tells an honest user what to do
 * differently.
 */
export const REJECTION_MESSAGES: Record<RejectionReason, string> = {
  "too-large": "That file is larger than the 5 MB limit.",
  "size-mismatch":
    "That upload did not complete as expected. Please try again.",
  "type-mismatch":
    "That file is not a JPEG, PNG, WebP or GIF image. Accepted images are " +
    "checked by their content, not their name.",
  infected: "That file was rejected by a security scan.",
  unscannable:
    "That file could not be security-scanned right now. Please try again " +
    "shortly.",
  unreadable: "That upload could not be verified. Please try again.",
  "not-promotable": "That upload could not be completed. Please try again.",
};
