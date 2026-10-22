/**
 * The half of bucketing that touches a request.
 *
 * Everything decided here is decided by the pure modules next to it — the hash,
 * the assignment fold, the rewrite lookup. What this file owns is the three
 * things only the proxy can do: read the cookies, *sanitise* the headers it
 * forwards, and turn the decision into a response.
 *
 * ## The sanitising is the security-relevant part
 *
 * The proxy forwards its findings to the application as request headers, which
 * is the documented way to get a value from `proxy.ts` into a Server Component
 * or a route handler. Those headers are indistinguishable, at the receiving
 * end, from headers the *client* sent — Next merges them into the same
 * `Headers` object, and nothing marks which of them the proxy wrote.
 *
 * So a request arriving with its own `x-experiment-assignments: admin-ui:on`
 * would be read by the application as though the proxy had decided it. This
 * file therefore deletes every internal header from the incoming request before
 * setting its own, unconditionally — including on paths that take no part in
 * bucketing, where nothing is set and the deletion is the whole point. Deleting
 * only the headers we are about to overwrite would leave a hole the moment one
 * is added to the list in one place and not the other, so the list is one
 * constant and the deletion walks it.
 *
 * `@/lib/experiments/geo` makes the same argument from the other side:
 * `x-geo-country` is *read* from the client only when the deployment opts in,
 * and it is overwritten here on the way through either way.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  assignmentsChanged,
  persistableAssignments,
  resolveAssignments,
  type Assignment,
} from "@/lib/experiments/assignment";
import {
  ASSIGNMENT_COOKIE,
  VISITOR_COOKIE,
  cookieAttributes,
  isSecureRequest,
  isVisitorId,
  mintVisitorId,
  parseAssignments,
  serialiseAssignments,
  type CookieAttributes,
} from "@/lib/experiments/cookies";
import { splitLocalePath } from "@/i18n/path";
import { EXPERIMENTS, type Experiment } from "@/lib/experiments/definitions";
import { readGeo, type RequestGeo } from "@/lib/experiments/geo";
import {
  parseOverrides,
  participates,
  resolveRewrite,
  type RewriteDecision,
} from "@/lib/experiments/routing";

/** Country the proxy established, forwarded to the application. */
export const GEO_HEADER = "x-geo-country";

/** Every assignment, as `experiment:variant:source`, for the application. */
export const ASSIGNMENTS_HEADER = "x-experiment-assignments";

/** Exposed assignments only, as `experiment:variant`, on the response. */
export const EXPOSURE_HEADER = "x-experiment-exposure";

/**
 * Headers the proxy owns end to end.
 *
 * Stripped from every inbound request before anything is set, so a client
 * cannot supply one. Listed once, walked in `sanitise`, and asserted by
 * `scripts/assert-experiment-wiring.ts`.
 */
export const INTERNAL_REQUEST_HEADERS = [
  GEO_HEADER,
  ASSIGNMENTS_HEADER,
] as const;

export interface ExperimentContext {
  readonly visitorId: string;
  /** True when the id was minted on this request rather than read back. */
  readonly isNewVisitor: boolean;
  readonly geo: RequestGeo;
  readonly assignments: readonly Assignment[];
  readonly rewrite: RewriteDecision | undefined;
  /** Whether this path takes part at all; false for `/api` and Next internals. */
  readonly participating: boolean;
  /** Serialised persistable assignments, ready for the cookie. */
  readonly cookieValue: string;
  /** Whether the cookies need writing — see `assignmentsChanged`. */
  readonly cookiesNeedWriting: boolean;
  /** The canonical path of the experiment this request is on, if any. */
  readonly canonicalPath: string | undefined;
}

export interface ResolveContextOptions {
  readonly experiments?: readonly Experiment[];
  /** Overrides the geo opt-in. For tests; production reads the env. */
  readonly trustForwardedGeo?: boolean;
  /** Overrides id minting. For tests; production uses `crypto.randomUUID`. */
  readonly mintId?: () => string;
}

/** The canonical path of whichever experiment owns this request, if any. */
function canonicalPathFor(
  pathname: string,
  experiments: readonly Experiment[],
): string | undefined {
  return experiments.find((experiment) => experiment.route?.path === pathname)
    ?.route?.path;
}

/**
 * Everything the proxy needs to know about this request, in one pass.
 *
 * Runs for non-participating paths too, and returns a context that says so.
 * That is what lets the caller keep one code path: an `/api` request still has
 * its inbound internal headers stripped, still gets no cookie, and still
 * produces no rewrite, without the proxy having to branch on the pathname
 * itself.
 */
export function resolveExperimentContext(
  request: NextRequest,
  options: ResolveContextOptions = {},
): ExperimentContext {
  const experiments = options.experiments ?? EXPERIMENTS;
  // The locale comes off before anything is matched against the registry.
  //
  // An experiment's `route.path` is a public path — `/pricing` — and the URL of
  // that page in `ar` is `/ar/pricing`, which equals it for no experiment and
  // so took part in none. Every visitor on a prefixed locale would have been
  // served the canonical arm, and because `canonicalPath` would also have been
  // `undefined`, with no exposure header to say so: the experiment would have
  // gone on reporting a difference between two populations one of which was
  // never split, and the only evidence would have been a traffic split that did
  // not add up.
  //
  // The paths in `rewrite` stay public for the same reason they are public in
  // the registry — this module is the one that holds a `NextRequest` and the
  // one below it is strings in, strings out. `src/proxy.ts` is what turns the
  // decision into a segment path with `internalPath`.
  const { pathname } = splitLocalePath(request.nextUrl.pathname);
  const participating = participates(pathname);

  if (!participating) {
    return {
      visitorId: "",
      isNewVisitor: false,
      geo: readGeo(new Headers()),
      assignments: [],
      rewrite: undefined,
      participating: false,
      cookieValue: "",
      cookiesNeedWriting: false,
      canonicalPath: undefined,
    };
  }

  const cookieId = request.cookies.get(VISITOR_COOKIE)?.value;
  const known = cookieId !== undefined && isVisitorId(cookieId);
  const mint = options.mintId ?? mintVisitorId;
  const visitorId = known ? cookieId : mint();

  const geo = readGeo(
    request.headers,
    options.trustForwardedGeo === undefined
      ? {}
      : { trustForwarded: options.trustForwardedGeo },
  );

  // A visitor whose id we just minted has no assignments worth reading, even if
  // a cookie is present: the assignments in it were derived from an id that is
  // no longer theirs, so honouring them would carry an arm across a re-bucket.
  const existing = known
    ? parseAssignments(request.cookies.get(ASSIGNMENT_COOKIE)?.value)
    : new Map<string, string>();

  const assignments = resolveAssignments({
    experiments,
    visitorId,
    country: geo.country,
    existing,
    overrides: parseOverrides(request.nextUrl.searchParams),
  });

  const persisted = persistableAssignments(assignments);

  return {
    visitorId,
    isNewVisitor: !known,
    geo,
    assignments,
    rewrite: resolveRewrite(pathname, assignments, experiments),
    participating: true,
    cookieValue: serialiseAssignments(persisted),
    cookiesNeedWriting: !known || assignmentsChanged(persisted, existing),
    canonicalPath: canonicalPathFor(pathname, experiments),
  };
}

/** `experiment:variant:source|…` — every assignment, for the application. */
export function formatAssignments(assignments: readonly Assignment[]): string {
  return assignments
    .map(
      (assignment) =>
        `${assignment.experimentId}:${assignment.variantId}:${assignment.source}`,
    )
    .join("|");
}

/** `experiment:variant|…` — the measured ones only, for analytics. */
export function formatExposure(assignments: readonly Assignment[]): string {
  return assignments
    .filter((assignment) => assignment.exposed)
    .map((assignment) => `${assignment.experimentId}:${assignment.variantId}`)
    .join("|");
}

/**
 * The inbound headers, with the internal ones replaced by ours.
 *
 * A copy: `request.headers` is immutable in the proxy, and `NextResponse.next`
 * and `NextResponse.rewrite` both take the replacement explicitly.
 */
export function sanitisedRequestHeaders(
  request: NextRequest,
  context: ExperimentContext,
): Headers {
  const headers = new Headers(request.headers);

  for (const header of INTERNAL_REQUEST_HEADERS) headers.delete(header);
  if (!context.participating) return headers;

  headers.set(GEO_HEADER, context.geo.country);

  const assignments = formatAssignments(context.assignments);
  if (assignments !== "") headers.set(ASSIGNMENTS_HEADER, assignments);

  return headers;
}

/** One `Set-Cookie` value. Attribute order follows RFC 6265's own listing. */
export function setCookieHeader(
  name: string,
  value: string,
  attributes: CookieAttributes,
): string {
  const parts = [
    `${name}=${value}`,
    `Max-Age=${attributes.maxAge}`,
    `Path=${attributes.path}`,
    `SameSite=${attributes.sameSite === "lax" ? "Lax" : attributes.sameSite}`,
  ];
  if (attributes.secure) parts.push("Secure");
  if (attributes.httpOnly) parts.push("HttpOnly");
  return parts.join("; ");
}

/**
 * Copies a response's headers onto another one.
 *
 * `Set-Cookie` goes through `getSetCookie()` and `append`, because it is the
 * one header that legitimately occurs more than once and the iterator hands it
 * back as a single comma-joined string — copying *that* produces one malformed
 * cookie out of two valid ones, and does it only when a response happens to set
 * two, which is not the common case and so not the one anybody tests.
 *
 * `x-middleware-*` is skipped. Those are Next's own instructions to itself
 * about what a proxy response means; carrying `x-middleware-next` onto a
 * rewrite would tell Next both "continue" and "render this other path".
 */
export function carryOverHeaders(from: Response, to: Response): void {
  for (const cookie of from.headers.getSetCookie()) {
    to.headers.append("set-cookie", cookie);
  }
  for (const [name, value] of from.headers) {
    if (name === "set-cookie") continue;
    if (name.startsWith("x-middleware-")) continue;
    to.headers.set(name, value);
  }
}

/**
 * The response the proxy returns, given what the session gate decided.
 *
 * Three shapes, in order:
 *
 *  - **The gate refused.** A redirect to `/login` or `/forbidden` is returned
 *    as it is, with no rewrite and no experiment headers — but *with* the
 *    cookies, so the visitor who signs in and comes back is the same visitor
 *    rather than a freshly minted one. Rewriting a refusal would serve the
 *    variant page to a request the gate just declined.
 *
 *  - **A rewrite applies.** `NextResponse.rewrite` to the variant path, with
 *    the search string preserved so an override survives a reload.
 *
 *  - **Neither.** `NextResponse.next`, carrying the sanitised headers.
 *
 * The last two rebuild the response rather than mutating the gate's, because
 * `NextResponse.next()` cannot be turned into a rewrite after the fact — the
 * instruction is the response. `carryOverHeaders` is what keeps whatever the
 * gate set, a rotated session cookie above all.
 */
export interface ApplyExperimentsOptions {
  /**
   * The segment path this request must be rewritten to, or `undefined` for a
   * request that is passed straight through.
   *
   * This used to be derived here, from `context.rewrite?.to`, and it cannot be
   * any more: with the `[locale]` segment every page request needs a rewrite,
   * not only a bucketed one. `/pricing` is answered by
   * `src/app/[locale]/pricing/page.tsx`, so the path that renders it is
   * `/en/pricing` — a `NextResponse.next()` here would hand Next a path with
   * no route behind it and 404 the whole application at the default locale.
   *
   * So the caller computes it, because the caller is the only place that knows
   * both halves: the locale `next-intl` settled on, and the arm this visitor
   * was assigned. `src/proxy.ts` composes the two with `internalPath`.
   * `undefined` is for the paths that live outside the segment — `/api/*` — and
   * for requests this module is asked about directly in a test.
   */
  readonly rewriteTo?: string | undefined;
  /**
   * The request headers the pass-through or rewrite should carry.
   *
   * Defaults to `sanitisedRequestHeaders(request, context)`, which is all this
   * module needs. The proxy passes its own copy because the Content Security
   * Policy has to be on the request Next renders — Next reads the nonce out of
   * it — and that header belongs to `@/lib/security/apply`, not here. Passing
   * the headers in keeps this module's list of internal headers its own, and
   * keeps the proxy from having to rebuild a response that has already been
   * turned into a rewrite.
   */
  readonly requestHeaders?: Headers;
}

export function applyExperiments(
  request: NextRequest,
  context: ExperimentContext,
  gateResponse: Response,
  options: ApplyExperimentsOptions = {},
): Response {
  const secure = isSecureRequest(request.nextUrl, request.headers);
  const attributes = cookieAttributes(secure);

  const writeCookies = (response: Response): void => {
    if (!context.participating || !context.cookiesNeedWriting) return;
    response.headers.append(
      "set-cookie",
      setCookieHeader(VISITOR_COOKIE, context.visitorId, attributes),
    );
    response.headers.append(
      "set-cookie",
      setCookieHeader(ASSIGNMENT_COOKIE, context.cookieValue, attributes),
    );
  };

  // A refusal. `location` is the honest test: NextAuth answers with
  // `Response.redirect`, whose status is 302/307 and which never carries the
  // `x-middleware-next` marker a pass-through does.
  if (gateResponse.headers.has("location")) {
    writeCookies(gateResponse);
    return gateResponse;
  }

  const headers =
    options.requestHeaders ?? sanitisedRequestHeaders(request, context);

  const response =
    options.rewriteTo === undefined
      ? NextResponse.next({ request: { headers } })
      : NextResponse.rewrite(rewriteUrl(request, options.rewriteTo), {
          request: { headers },
        });

  carryOverHeaders(gateResponse, response);
  writeCookies(response);

  // Reported on the canonical path only: that is the request whose arm was
  // decided, and a header on every other page view would be noise in a log.
  //
  // There is deliberately no `Vary: Cookie` here. It is the correct HTTP answer
  // to a response that varies by cookie and Next discards it — see
  // `@/lib/experiments/cache`, which has the two experiments establishing that
  // and the `Cache-Control` used instead. A `Vary` set on this response would
  // read like a protection and never reach a cache.
  if (context.participating && context.canonicalPath !== undefined) {
    const exposure = formatExposure(context.assignments);
    if (exposure !== "") response.headers.set(EXPOSURE_HEADER, exposure);
  }

  return response;
}

/**
 * The URL a rewrite points at.
 *
 * Built by cloning `nextUrl` and replacing the pathname rather than by
 * `new URL(to, request.url)`, which would drop the search string — and with it
 * the `?bkt_…` override that produced the rewrite in the first place, so a
 * forced arm would survive exactly one render.
 */
function rewriteUrl(request: NextRequest, pathname: string): URL {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  return url;
}
