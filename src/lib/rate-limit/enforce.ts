/**
 * The enforcement point: turn a request into a decision, and a decision into
 * headers or a refusal.
 *
 * ## "At the edge", and what that means in Next 16
 *
 * The spec item this file answers asks for rate limiting *at the edge*. Next 16
 * does not offer an edge runtime to put it on, and this was checked in the
 * framework's own source rather than assumed:
 *
 *   - The proxy (`src/proxy.ts`) always runs on Node.
 *     `get-page-static-info.js` rejects a runtime segment config in that file
 *     outright — *"Route segment config is not allowed in Proxy file … Proxy
 *     always runs on Node.js runtime."* — and the build's own
 *     `functions-config-manifest.json` records `/_middleware` as `nodejs`.
 *   - Route handlers cannot declare one either, for the separate reason
 *     `@/lib/api/runtimes` documents: `cacheComponents` is on repo-wide and
 *     rejects the `runtime` export for `"edge"` and `"nodejs"` alike.
 *
 * So nothing in this application runs on the edge runtime, and a rate limiter
 * claiming to is claiming something the reader can check and find false. What
 * the item is actually about survives intact, and is what this delivers: the
 * limit is applied at the **first** point the request reaches, in the proxy,
 * before routing, before the session is read, before a Server Action is
 * deserialised, and before any database connection is opened. That is the
 * property "at the edge" is shorthand for, and it is the one that decides
 * whether a flood costs the application anything.
 *
 * The module graph is kept to the Fetch API and `next/server` regardless, so
 * the day a runtime choice exists this moves without being rewritten. That is
 * the same discipline `API_ROUTES.portable` records for route handlers, and
 * `scripts/assert-rate-limit-coverage.ts` reports the runtime the build
 * actually used so a change in the framework is noticed rather than assumed.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { clientIdentity } from "@/lib/rate-limit/client-identity";
import { isApiPath, selectPolicy } from "@/lib/rate-limit/policy";
import { rateLimitStore } from "@/lib/rate-limit/store";
import type { RateLimitStore } from "@/lib/rate-limit/store";
import type {
  RateLimitPolicy,
  RequestDescriptor,
} from "@/lib/rate-limit/policy";
import type { RateLimitDecision } from "@/lib/rate-limit/window";

/** What the caller is told. Fixed, and says nothing about which limit or whose. */
export const TOO_MANY_REQUESTS_MESSAGE =
  "Too many requests. Please slow down and try again shortly.";

export interface RateLimitOutcome {
  policy: RateLimitPolicy;
  decision: RateLimitDecision;
  /** The full store key. Present so a log line can say what was counted. */
  key: string;
}

/**
 * Whether a POST is a Server Action.
 *
 * Two tests, and the second is the one that matters. Next sends a `Next-Action`
 * header when the browser has JavaScript and calls the action through its own
 * client runtime. It does **not** send one for the progressive-enhancement
 * path, where a plain `<form action={…}>` submits without JavaScript and the
 * action id travels in the form body instead — and it does not send one for
 * `curl`, which is what an attacker is using. A limiter that keys on the header
 * alone is therefore bypassed by omitting the header, which is the easiest
 * thing in the request to omit.
 *
 * The fallback is structural rather than heuristic: in an App Router
 * application there is no way to POST to a page path *except* a Server Action.
 * There are no page-level POST handlers; a POST to `/login` is either an action
 * invocation or a request for a route that does not exist. Counting both is
 * correct, and the second costs an attacker the bypass.
 */
export function isServerActionRequest(request: NextRequest): boolean {
  if (request.method !== "POST") return false;
  if (request.headers.has("next-action")) return true;
  return !isApiPath(request.nextUrl.pathname);
}

export function describeRequest(request: NextRequest): RequestDescriptor {
  return {
    method: request.method,
    pathname: request.nextUrl.pathname,
    isServerAction: isServerActionRequest(request),
  };
}

/** Seconds until `at`, as the RateLimit headers want it: a non-negative integer. */
function secondsUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * The IETF `RateLimit-*` fields (draft-ietf-httpapi-ratelimit-headers), which
 * is what clients and SDKs actually look for.
 *
 * Set on **allowed** responses too, not only on refusals. A client that can see
 * its remaining budget can slow itself down; one that only learns about the
 * limit by hitting it can only retry into it.
 *
 * `RateLimit-Reset` is the decision's `resetAt` — when the whole budget is
 * available again — and `Retry-After` below is its `retryAt`, the earlier
 * instant one more request would get through. They are different numbers under
 * a sliding window and conflating them is how a client that obeys the header is
 * refused a second time.
 */
export function rateLimitHeaders(
  outcome: RateLimitOutcome,
  now: number,
): Record<string, string> {
  const { policy, decision } = outcome;
  const windowSeconds = Math.ceil(policy.windowMs / 1000);

  return {
    "RateLimit-Limit": String(decision.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(secondsUntil(decision.resetAt, now)),
    "RateLimit-Policy": `${decision.limit};w=${windowSeconds}`,
  };
}

/**
 * The 429.
 *
 * Two body shapes, because there are two kinds of caller. A route handler's
 * client gets the same `{ error: { code, message } }` envelope every other
 * failure from `@/lib/api/errors` uses, so a client branching on
 * `body.error.code` keeps working at the one status it did not previously
 * receive. Everything else gets `text/plain`.
 *
 * A refused **Server Action** is the unavoidably rough edge, and it is worth
 * being plain about: the proxy cannot synthesise a React Flight payload, so the
 * action's caller sees a failed request rather than an `ActionResult` carrying
 * a sentence, and `useActionState` surfaces it through the segment's
 * `error.tsx` rather than in the form. Giving a refused action a proper
 * in-form message needs the limit applied a second time inside the action
 * factory, where the result channel exists. See docs/rate-limiting.md.
 *
 * `Retry-After` uses at least one second: a `Retry-After: 0` is an instruction
 * to retry immediately, which is the opposite of the message.
 */
export function tooManyRequests(
  request: NextRequest,
  outcome: RateLimitOutcome,
  now: number,
): NextResponse {
  const headers = {
    ...rateLimitHeaders(outcome, now),
    "Retry-After": String(
      Math.max(1, secondsUntil(outcome.decision.retryAt, now)),
    ),
  };

  if (isApiPath(request.nextUrl.pathname)) {
    return NextResponse.json(
      new ApiError("too_many_requests", TOO_MANY_REQUESTS_MESSAGE).toBody(),
      { status: 429, headers },
    );
  }

  return new NextResponse(`${TOO_MANY_REQUESTS_MESSAGE}\n`, {
    status: 429,
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
  });
}

export interface EnforceOptions {
  store?: RateLimitStore;
  now?: number;
  /** Overrides the trusted-proxy depth. For tests; production reads the env. */
  trustedProxies?: number;
}

/**
 * Counts the request, if anything counts it.
 *
 * Returns `undefined` when no policy applies, which is the answer for every
 * page navigation and prefetch. Nothing is read, nothing is written and no key
 * is allocated in that case — the cost of the limiter on the traffic it does
 * not limit is one table walk.
 */
export async function enforceRateLimit(
  request: NextRequest,
  options: EnforceOptions = {},
): Promise<RateLimitOutcome | undefined> {
  const selected = selectPolicy(describeRequest(request));
  if (!selected) return undefined;

  const store = options.store ?? rateLimitStore;
  const now = options.now ?? Date.now();
  const identity =
    options.trustedProxies === undefined
      ? clientIdentity(request.headers)
      : clientIdentity(request.headers, options.trustedProxies);

  const key = `${selected.scope}|${identity.key}`;
  const decision = await store.consume(key, selected.policy, now);

  return { policy: selected.policy, decision, key };
}

/**
 * Copies the headers onto a response the rest of the proxy produced.
 *
 * Mutates and returns the same response rather than cloning it. A clone would
 * have to reconstruct the body, and the body here can be a stream — the one
 * `NextResponse.next()` returns, and whatever a redirect carries. Header maps
 * on a `Response` built by `next/server` are mutable, which is what makes this
 * safe; the alternative, `new Response(response.body, response)`, is what
 * NextAuth already does one layer down and doing it twice buys nothing.
 */
export function applyRateLimitHeaders<T extends Response>(
  response: T,
  outcome: RateLimitOutcome | undefined,
  now: number,
): T {
  if (!outcome) return response;

  for (const [name, value] of Object.entries(rateLimitHeaders(outcome, now))) {
    response.headers.set(name, value);
  }

  return response;
}
