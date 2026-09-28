/**
 * The antivirus hook: a seam an engine plugs into, and the policy for what
 * happens when it does not answer.
 *
 * This deliberately does not bundle a scanner. There is no credible way to ship
 * malware detection in a Node dependency — the engines that exist are native,
 * they need a signature database that updates daily, and a boilerplate that
 * vendored one would be shipping a stale database with a version number on it.
 * What a boilerplate can get right is the *shape*: where the call goes, what it
 * is allowed to say, and what the upload path does with each answer. That shape
 * is the part people get wrong, and it is checkable.
 *
 * ## The scanner is handed a location, not the bytes
 *
 * `scan` receives the bucket and key. The alternative — read the object into
 * this process and post it to the scanner — means a 5 MB buffer per concurrent
 * upload in a request handler, and two transfers of the same object to do one
 * scan. Every deployment shape worth having (a Lambda on an S3 event, ClamAV in
 * a sidecar with the bucket mounted, a vendor API taking a presigned URL) reads
 * the object itself. So the readback in `@/lib/uploads/storage` stays bounded to
 * the 512 header bytes the sniffer needs, and the scanner does its own I/O.
 *
 * ## Fail open or fail closed
 *
 * Both, decided by whether a scanner is configured, because one answer is wrong
 * in each direction:
 *
 *   - Fail closed always, and a fresh clone with no `UPLOAD_SCANNER_URL`
 *     rejects every upload. The feature ships broken, and the first person to
 *     hit it fixes it by taking the check out.
 *   - Fail open always, and the deployment that configured a scanner keeps
 *     accepting uploads when it goes down. That is the bug this hook exists to
 *     prevent: an outage silently becomes an absence of scanning, and nothing
 *     in the system distinguishes "clean" from "not asked".
 *
 * So: no scanner configured is a supported state in which every upload is
 * accepted and every one writes an `unscanned` audit line at `warn`, so the
 * absence is in the logs rather than in someone's memory of the deployment. A
 * configured scanner is a decision that scanning is required, and from then on
 * `unavailable` refuses the upload. The two states are `ScanRequirement`, which
 * is derived from the environment in `resolveUploadScanner` and is never a
 * parameter a caller chooses — a boolean that reaches this decision from a
 * request is the whole bug in one argument.
 */
import "server-only";

import { serverEnv } from "@/lib/env/server";
import type { AllowedMimeType } from "@/lib/uploads/policy";

/** What the scanner is asked about. */
export interface ScanTarget {
  bucket: string;
  key: string;
  declaredType: AllowedMimeType;
  /** The object's real length, as measured by the readback. */
  sizeBytes: number;
}

/**
 * What a scanner may answer.
 *
 * Three cases and not a boolean: "I did not run" has to be distinguishable from
 * "I ran and found nothing", or the policy above cannot be written. A scanner
 * that reports a timeout as `clean` is worse than no scanner, because it
 * produces the audit line of a scan that happened.
 */
export type ScanVerdict =
  | { status: "clean" }
  | { status: "infected"; signature: string }
  | { status: "unavailable"; reason: string };

export interface UploadScanner {
  /** Names the engine in the audit line, so a log says what did the scanning. */
  readonly name: string;
  /** Whether a non-answer from this scanner refuses the upload. */
  readonly requirement: ScanRequirement;
  scan(target: ScanTarget): Promise<ScanVerdict>;
}

export type ScanRequirement = "required" | "absent";

/** How long the scanner gets before its silence counts as `unavailable`. */
export const SCAN_TIMEOUT_MS = 10_000;

/**
 * The scanner used when none is configured.
 *
 * It answers `unavailable`, not `clean`, and that is the point of it existing at
 * all rather than the code branching on `undefined`. The verdict is truthful —
 * nothing scanned this object — and `requirement: "absent"` is the separate fact
 * that says the upload proceeds anyway. Collapsing the two into a `clean` here
 * would be a lie told in exactly the place a reviewer looks for the truth, and
 * it would put "no scanner" and "scanner timed out" into the same audit line.
 */
export const unconfiguredScanner: UploadScanner = {
  name: "none",
  requirement: "absent",
  scan: () =>
    Promise.resolve({
      status: "unavailable",
      reason: "no scanner configured (UPLOAD_SCANNER_URL is unset)",
    }),
};

/**
 * The verdict body a scanner service is expected to answer with.
 *
 * Parsed defensively rather than with Zod: this module is on the upload path in
 * a deployment where Zod's absence from the graph is not guaranteed, the shape
 * is three fields, and — more to the point — every parse failure has the same
 * outcome. An unrecognised body is `unavailable`, never `clean`, so a scanner
 * that changes its response format fails closed rather than passing everything.
 */
export function parseScanResponse(body: unknown): ScanVerdict {
  if (typeof body !== "object" || body === null) {
    return { status: "unavailable", reason: "scanner returned a non-object" };
  }

  const record = body as Record<string, unknown>;
  const status = record["status"];

  if (status === "clean") return { status: "clean" };

  if (status === "infected") {
    const signature = record["signature"];
    return {
      status: "infected",
      signature:
        typeof signature === "string" && signature.length > 0
          ? signature
          : "unnamed",
    };
  }

  return {
    status: "unavailable",
    reason: `scanner returned an unrecognised status: ${JSON.stringify(status)}`,
  };
}

/**
 * A scanner that POSTs the target to an HTTP service.
 *
 * `fetchImpl` is injectable for the same reason `@/lib/vitals/sink` takes one:
 * it is the only way to test the timeout, the non-2xx path and a malformed body
 * without a network. The default is the platform `fetch`, and this file is one
 * of the enumerated entries in `FETCH_CALL_SITES` — its target is
 * `serverEnv.UPLOAD_SCANNER_URL`, validated as a URL at boot and reachable from
 * no request.
 */
export function createHttpScanner(options: {
  endpoint: string;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): UploadScanner {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? SCAN_TIMEOUT_MS;

  return {
    name: "http",
    requirement: "required",
    async scan(target: ScanTarget): Promise<ScanVerdict> {
      // `AbortSignal.timeout` rather than a `Promise.race`: racing leaves the
      // request running, so a scanner that is slow because it is overloaded
      // keeps receiving work it can no longer answer for.
      const signal = AbortSignal.timeout(timeoutMs);

      try {
        const response = await fetchImpl(options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey
              ? { authorization: `Bearer ${options.apiKey}` }
              : {}),
          },
          body: JSON.stringify(target),
          signal,
        });

        if (!response.ok) {
          return {
            status: "unavailable",
            reason: `scanner answered HTTP ${response.status}`,
          };
        }

        return parseScanResponse(await response.json());
      } catch (error) {
        // Every throw lands here as `unavailable`: an abort, a DNS failure, a
        // body that is not JSON. None of them is evidence about the object.
        return {
          status: "unavailable",
          reason:
            error instanceof Error
              ? `scanner request failed: ${error.message}`
              : "scanner request failed",
        };
      }
    },
  };
}

/**
 * The scanner this deployment uses, chosen from the environment.
 *
 * A function rather than a module-level constant so that a test — and a
 * deployment that reloads configuration — is not reading a decision made at
 * import time, and so the `serverEnv` read happens inside the call rather than
 * at the top of every module that imports this one.
 */
export function resolveUploadScanner(fetchImpl?: typeof fetch): UploadScanner {
  const endpoint = serverEnv.UPLOAD_SCANNER_URL;
  if (!endpoint) return unconfiguredScanner;

  return createHttpScanner({
    endpoint,
    apiKey: serverEnv.UPLOAD_SCANNER_API_KEY,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/**
 * Whether this verdict lets the object through, given who produced it.
 *
 * The whole fail-open/fail-closed policy, in one place, as a pure function of
 * two values — so the gate can check that the upload path calls it rather than
 * re-deciding, and so the table can be read without following the upload flow.
 *
 *   clean       + any         → accept
 *   infected    + any         → refuse
 *   unavailable + required    → refuse
 *   unavailable + absent      → accept, and say so in the audit line
 */
export function scanAllowsUpload(
  verdict: ScanVerdict,
  requirement: ScanRequirement,
): boolean {
  if (verdict.status === "clean") return true;
  if (verdict.status === "infected") return false;
  return requirement === "absent";
}
