/**
 * The half of the policy that touches a request.
 *
 * `@/lib/security/csp` is pure: given a nonce, a mode and a list of digests it
 * returns a header value. This file is what a request turns into those inputs,
 * and it owns the three decisions that need one:
 *
 *  1. **Stripping the client's copy.** `content-security-policy` on an *inbound*
 *     request is read by `app-render` as the policy for that render, and the
 *     nonce it contains is stamped on every script in the response. Forwarded
 *     rather than deleted, that is an attacker-chosen nonce in the document —
 *     the exact hole the policy exists to close, opened by the policy's own
 *     plumbing. The deletion is unconditional and walks one list, for the reason
 *     `@/lib/experiments/edge` gives for doing the same with its own headers.
 *
 *  2. **Enforce or report.** Report-only is the rollout mode and `CSP_REPORT_ONLY`
 *     asks for it. It is also the automatic answer to a production server with
 *     no hash manifest: the alternative is enforcing a policy that refuses every
 *     script in every prerendered document, which is not a safer default, it is
 *     an outage. That case is logged once per process, loudly, and
 *     `scripts/assert-csp.ts` is what stops a build reaching production in that
 *     state.
 *
 *  3. **Which document the policy is for.** A rewritten request renders a path
 *     the browser never asked for — `/pricing` serves `/pricing/v/control` — so
 *     the lookup uses both, and takes the *stricter* answer of the two about
 *     whether that document is fixed. See `resolveShell`.
 *
 *  4. **Withholding the nonce where it would do harm.** For a path Next may
 *     re-render and cache — an ISR route — the nonce is not minted into the
 *     policy *and not forwarded on the request*, because the render that
 *     repopulates the cache would stamp it into HTML every later visitor is
 *     served. See `PolicyInput.documentRegenerates` for the measurement.
 */
import { isSecureRequest } from "@/lib/experiments/cookies";
import {
  CSP_HEADER,
  CSP_REPORT_ONLY_HEADER,
  INTERNAL_CSP_HEADERS,
  NONCE_HEADER,
  buildPolicy,
  mintNonce,
} from "@/lib/security/csp";
import {
  MANIFEST_FILE,
  loadManifest,
  resolveShell,
} from "@/lib/security/shell-hashes";
import type { ShellHashManifest } from "@/lib/security/shell-hashes";
import type { ThirdPartyConfig } from "@/lib/third-party/catalogue";
import type { NextRequest } from "next/server";

/** Set to `1` to send the policy without enforcing it. See docs/csp.md. */
export const REPORT_ONLY_ENV = "CSP_REPORT_ONLY";

export interface CspDecision {
  /**
   * This request's nonce, forwarded to the render and never reused — or
   * `undefined` for a path whose document Next may re-render and cache, where a
   * nonce would be baked into a cache entry every later visitor is served. See
   * `PolicyInput.documentRegenerates`.
   */
  readonly nonce: string | undefined;
  /** The serialised policy. */
  readonly policy: string;
  /** Which header carries it: enforcing, or report-only. */
  readonly header: typeof CSP_HEADER | typeof CSP_REPORT_ONLY_HEADER;
}

export interface DecideOptions {
  /** Overridden in tests. Production mints one per request. */
  readonly nonce?: string;
  /** The path whose document will be rendered, when a rewrite applies. */
  readonly served?: string | undefined;
  /** Injected in tests; production reads the manifest the build emitted. */
  readonly shellHashes?: readonly string[] | undefined;
  /**
   * Injected in tests; production reads `.next/csp-shell-hashes.json`.
   *
   * Here because the absence of that file is a behaviour worth testing, and a
   * test that got its answer from the working directory would pass or fail on
   * whether anyone had run a build.
   */
  readonly readManifest?: () => ShellHashManifest | undefined;
  /** Injected in tests; production reads it from the same manifest entry. */
  readonly documentRegenerates?: boolean | undefined;
  readonly nodeEnv?: string | undefined;
  readonly reportOnly?: string | undefined;
  readonly thirdParty?: ThirdPartyConfig;
  /** Injected in tests. Production warns through the console, once. */
  readonly warn?: (message: string) => void;
}

/** Whether the missing-manifest warning has already been printed this process. */
let warnedAboutManifest = false;

/** Resets the once-per-process warning. Exported for tests. */
export function resetManifestWarning(): void {
  warnedAboutManifest = false;
}

const MISSING_MANIFEST_WARNING =
  `Content-Security-Policy: no ${MANIFEST_FILE} in the build directory, so the ` +
  "hashes of the prerendered documents' inline scripts are unknown and the policy is being " +
  "sent report-only. Run `pnpm csp:hashes` after `next build` (CI does, and " +
  "`scripts/assert-csp.ts` fails the build when it has not), and copy the file into the " +
  "runtime image — see docs/csp.md.";

/**
 * The policy for this request.
 *
 * `NODE_ENV` rather than a config flag, because the two things the development
 * policy relaxes are properties of the dev server itself: it is the dev server
 * that opens an HMR socket and evaluates module code from strings. So
 * `development` is the *only* value that relaxes them — a test run gets the
 * production policy, which is the one worth asserting against.
 *
 * Whether to look for the hash manifest is a separate question from which policy
 * to build, and keys on `production` alone: it is the one environment where a
 * document can come off disk, and looking for a build artefact from a unit test
 * would make the policy depend on whether anyone had run a build.
 */
export function decideCsp(
  request: NextRequest,
  options: DecideOptions = {},
): CspDecision {
  const nonce = options.nonce ?? mintNonce();
  const nodeEnv = options.nodeEnv ?? process.env["NODE_ENV"];
  const mode = nodeEnv === "development" ? "development" : "production";
  const servesPrerendered = nodeEnv === "production";
  const warn = options.warn ?? ((message: string) => console.error(message));

  const thirdParty = options.thirdParty ?? {
    plausibleDomain: process.env["NEXT_PUBLIC_PLAUSIBLE_DOMAIN"] || undefined,
  };

  let shellHashes = options.shellHashes;
  let regenerates = options.documentRegenerates ?? false;
  let missingManifest = false;

  if (shellHashes === undefined) {
    const read = options.readManifest ?? loadManifest;
    const manifest = servesPrerendered ? read() : undefined;

    if (manifest === undefined) {
      // Only a problem in production. `next dev` prerenders nothing: every
      // document is rendered on demand and every script in it is nonced, so
      // there is nothing for a hash to authorise.
      missingManifest = servesPrerendered;
      shellHashes = [];
    } else {
      const shell = resolveShell(
        manifest,
        request.nextUrl.pathname,
        options.served,
      );
      shellHashes = shell.hashes;
      regenerates = shell.regenerates;
    }
  }

  if (missingManifest && !warnedAboutManifest) {
    warnedAboutManifest = true;
    warn(MISSING_MANIFEST_WARNING);
  }

  const askedForReportOnly =
    (options.reportOnly ?? process.env[REPORT_ONLY_ENV]) === "1";

  return {
    // Withheld rather than merely left out of the policy: `applyCspRequestHeaders`
    // must not forward it either, or Next stamps it on the render that
    // repopulates the cache and every later visitor is served that nonce.
    nonce: regenerates ? undefined : nonce,
    policy: buildPolicy({
      nonce: regenerates ? undefined : nonce,
      shellHashes,
      mode,
      secure: isSecureRequest(request.nextUrl, request.headers),
      thirdParty,
      documentRegenerates: regenerates,
    }),
    header:
      askedForReportOnly || missingManifest
        ? CSP_REPORT_ONLY_HEADER
        : CSP_HEADER,
  };
}

/**
 * Puts the policy on the request Next is about to render.
 *
 * Both headers, and they do different jobs. The policy is what `app-render`
 * parses the nonce out of — that is the whole mechanism, and Next reads the
 * report-only header for it as well, so a report-only deployment still gets
 * nonced markup. `x-nonce` is the copy a dynamically rendered route can read
 * with `headers()` to put the nonce on an inline script of its own. Nothing in
 * this application reads it, deliberately: a `headers()` call in a layout or a
 * page makes every route beneath it dynamic, which is the regression
 * `scripts/assert-route-shape.ts` exists to catch. It is set because a
 * consumer's own dynamic route is the case it is for.
 *
 * Mutates the `Headers` copy the caller is going to hand to `NextResponse.next`
 * or `NextResponse.rewrite`; `request.headers` itself is immutable in the proxy.
 */
export function applyCspRequestHeaders(
  headers: Headers,
  decision: CspDecision,
): Headers {
  stripInboundCspHeaders(headers);
  headers.set(decision.header, decision.policy);
  if (decision.nonce !== undefined) headers.set(NONCE_HEADER, decision.nonce);
  return headers;
}

/**
 * Deletes every header this module owns from a copy of the inbound request.
 *
 * Separate from the setter because it has to happen on paths that set nothing:
 * an `/api` request, a refusal, a redirect. One list, walked, so a header added
 * to `INTERNAL_CSP_HEADERS` is stripped without anyone having to remember a
 * second place.
 */
export function stripInboundCspHeaders(headers: Headers): Headers {
  for (const header of INTERNAL_CSP_HEADERS) headers.delete(header);
  return headers;
}

/** Puts the policy on the response the browser gets. */
export function applyCspHeaders<T extends Response>(
  response: T,
  decision: CspDecision,
): T {
  response.headers.set(decision.header, decision.policy);
  return response;
}
