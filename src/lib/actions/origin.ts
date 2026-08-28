/**
 * The origin leg of Server Action hardening.
 *
 * ## What Next already does, and the hole this closes
 *
 * Next 16 does check the origin of a Server Action POST. `handleAction` in
 * `next/dist/server/app-render/action-handler.js` compares the `Origin`
 * header's host against `x-forwarded-host` (preferred) or `host`, consults
 * `serverActions.allowedOrigins` from `next.config`, and aborts with
 * `Invalid Server Actions request.` on a mismatch. That covers the ordinary
 * browser CSRF case, and this module does not replace it.
 *
 * It has one documented gap, in the framework's own words:
 *
 *     if (!originHost) {
 *       // This is a handcrafted request without an origin or a request from an
 *       // unsafe browser. We'll let this through but log a warning.
 *       warning = 'Missing `origin` header from a forwarded Server Actions request.'
 *     }
 *
 * A request with no `Origin` header at all is *allowed*, and the only trace is
 * a line in the server log. The reasoning ("handcrafted requests can't contain
 * user credentials that haven't been shared willingly") is sound for a request
 * an attacker makes from their own machine and wrong for anything that can
 * induce a credentialed request without JavaScript setting the header — an old
 * or non-conforming browser, an embedded webview, a client library replaying a
 * captured request with the user's cookie jar. Every one of those is a stretch;
 * none of them is a reason to accept an unauthenticated origin claim when
 * refusing costs nothing. Browsers have sent `Origin` on cross-origin POSTs for
 * years, so the strict rule below rejects nothing a real browser sends.
 *
 * So: **absent means refused here, where Next means allowed-with-a-warning.**
 * That is the entire difference, and it is the reason this module exists rather
 * than a comment saying "the framework handles it".
 *
 * ## Why it is per-action and not middleware
 *
 * Because the other two legs — authentication and input parsing — are
 * necessarily per-action, and a hardening story split across two layers is one
 * that gets half-applied. `scripts/assert-action-hardening.ts` can prove every
 * export of every `"use server"` module goes through a factory that calls this;
 * it could prove nothing about a middleware that may or may not match the route
 * an action happens to be posted to.
 *
 * ## Configuration
 *
 * `next.config.ts` deliberately does **not** set `serverActions.allowedOrigins`.
 * Empty is the framework's strictest setting (same host only), this module is
 * strictly stricter, and two allowlists for one property is how they drift.
 * Deployments that terminate at a proxy which rewrites neither `host` nor
 * `x-forwarded-host` set `ALLOWED_ACTION_ORIGINS` instead — one list, read at
 * runtime, testable.
 */
import { headers } from "next/headers";
import { env } from "@/lib/env";
import { ActionError } from "@/lib/actions/result";

/**
 * What the caller sees when the check fails.
 *
 * Fixed and uninformative on purpose. A message naming the expected host tells
 * whoever is probing exactly what to forge, and the caller who legitimately
 * trips this is a misconfigured proxy — whose operator reads the server log
 * line, which does name both sides.
 */
export const ORIGIN_REJECTED_MESSAGE =
  "This request could not be verified. Please reload the page and try again.";

export interface OriginCheckInput {
  /** The `Origin` header, verbatim. `null` for an opaque origin. */
  origin: string | null;
  /** The `Host` header. */
  host: string | null;
  /** The `X-Forwarded-Host` header, possibly a comma-separated list. */
  forwardedHost: string | null;
  /** Extra hosts to accept, already normalised by `parseAllowedOrigins`. */
  allowedHosts: readonly string[];
}

export type OriginCheck =
  { allowed: true; host: string } | { allowed: false; reason: string };

/**
 * Parses `ALLOWED_ACTION_ORIGINS` into a list of lowercased hosts.
 *
 * Accepts both spellings people actually write — a full origin
 * (`https://app.example.com`) and a bare host (`app.example.com:8443`) —
 * because rejecting one of them at boot is a worse failure than normalising
 * both. Everything reduces to a host with its port, which is what `Origin`
 * yields and what the `Host` header carries.
 *
 * Wildcards are not supported. Next's own `allowedOrigins` does support them
 * (`*.example.com`), and a deployment that genuinely needs one should say so
 * there; an allowlist that this repository can match with `Set.has` is one
 * whose behaviour is obvious from reading it.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];

  const hosts: string[] = [];

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;

    if (trimmed.includes("://")) {
      try {
        hosts.push(new URL(trimmed).host.toLowerCase());
      } catch {
        // A malformed entry is dropped rather than thrown on. Throwing here
        // would be a boot failure in `env`, and an allowlist is an escape hatch
        // for a proxy topology — refusing to start because one entry has a typo
        // turns a permissive setting into an outage.
        continue;
      }
      continue;
    }

    hosts.push(trimmed.toLowerCase());
  }

  return hosts;
}

/** The `x-forwarded-host` value a proxy chain actually claims: the first hop. */
function firstForwardedHost(value: string | null): string | null {
  if (value === null) return null;
  const first = value.split(",")[0]?.trim();
  return first === undefined || first === "" ? null : first;
}

/**
 * The origin decision, as a pure function of four header values.
 *
 * Split from `assertSameOrigin` so the rules are testable without a request:
 * every branch below is a case in `origin.test.ts`, which is not something a
 * function that calls `headers()` can offer.
 */
export function checkOrigin(input: OriginCheckInput): OriginCheck {
  const { origin, allowedHosts } = input;

  if (origin === null) {
    // The gap described at the top of this file.
    return { allowed: false, reason: "no Origin header" };
  }

  if (origin === "null") {
    // An opaque origin: a sandboxed iframe, a `data:` document, a redirect from
    // a different scheme. It names no host, so it can never match one, and
    // saying so explicitly beats letting `new URL("null")` throw into the
    // malformed branch with a misleading reason.
    return { allowed: false, reason: "opaque (null) Origin" };
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return { allowed: false, reason: `unparseable Origin "${origin}"` };
  }

  if (originHost === "") {
    // `new URL("file:///x")` parses with an empty host. Nothing legitimate
    // posts an action from one, and an empty string must not be allowed to
    // match an empty `Host`.
    return { allowed: false, reason: `Origin "${origin}" names no host` };
  }

  // `x-forwarded-host` before `host`, matching `parseHostHeader` in Next's
  // action handler. Behind a proxy the `host` this process sees is the internal
  // one and would never match the public origin the browser sent.
  const expected = (
    firstForwardedHost(input.forwardedHost) ??
    input.host ??
    ""
  ).toLowerCase();

  if (expected !== "" && originHost === expected) {
    return { allowed: true, host: originHost };
  }

  if (allowedHosts.includes(originHost)) {
    return { allowed: true, host: originHost };
  }

  if (expected === "") {
    return {
      allowed: false,
      reason: `Origin "${originHost}" cannot be checked: no Host or X-Forwarded-Host header`,
    };
  }

  return {
    allowed: false,
    reason: `Origin "${originHost}" does not match "${expected}"`,
  };
}

/**
 * Reads the request headers and throws `ActionError` unless the origin checks
 * out.
 *
 * Every factory in this directory calls this first — before the session read,
 * before the schema — because it is the cheapest of the three legs and the one
 * whose failure means the request should never have reached us at all.
 */
export async function assertSameOrigin(): Promise<void> {
  const headerList = await headers();

  const result = checkOrigin({
    origin: headerList.get("origin"),
    host: headerList.get("host"),
    forwardedHost: headerList.get("x-forwarded-host"),
    allowedHosts: parseAllowedOrigins(env.ALLOWED_ACTION_ORIGINS),
  });

  if (result.allowed) return;

  // Logged, not returned. The operator of a misconfigured proxy needs both
  // sides of the comparison; the caller gets the fixed sentence above.
  console.error(`[action] rejected cross-origin request: ${result.reason}`);

  throw new ActionError(ORIGIN_REJECTED_MESSAGE);
}
