/**
 * What is limited, how hard, and why — in one table.
 *
 * The same argument `@/lib/api/runtimes` makes for runtimes: a budget that
 * lives inline at the point it is applied is invisible from anywhere else, and
 * an endpoint that has no budget looks exactly like one whose budget is
 * generous. Here every rule is a row with a sentence attached, and
 * `scripts/assert-rate-limit-coverage.ts` fails the build when a route handler
 * exists that no row matches and no row exempts.
 *
 * ## What is not limited, and why that is deliberate
 *
 * Page navigations. Next prefetches every `<Link>` that scrolls into view, and
 * a prefetch is a request to the page's own path — so a reader who scrolls a
 * list issues dozens of GETs without touching the keyboard. A budget low enough
 * to be a defence would refuse the framework's own traffic; a budget high enough
 * not to would not be a defence. Volumetric protection for reads belongs in
 * front of the application, in a CDN or a WAF, where it can be applied without
 * knowing what a Server Component is. What this file limits is the traffic that
 * *costs* something and that no CDN can classify: mutations, credential
 * attempts, and the API surface.
 *
 * ## Buckets are per policy, not per rule
 *
 * Several rules can share a policy, and where they do it is on purpose. The
 * credentials Server Action posted to `/login` and NextAuth's own
 * `POST /api/auth/callback/credentials` are two doors into one password check;
 * giving them separate budgets would let an attacker alternate and get double
 * the attempts. They share `authentication`.
 */

/** A budget, with the reason it is what it is. */
export interface RateLimitPolicy {
  /** Identifies the bucket. Part of the store key, and reported in logs. */
  name: string;
  /** Requests permitted per window, per client. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Why this budget is this size — printed when the gate or a log line needs it. */
  because: string;
}

/** Everything a rule is allowed to look at. Derived once, in `@/lib/rate-limit/enforce`. */
export interface RequestDescriptor {
  method: string;
  pathname: string;
  /** True when this POST is a Server Action invocation. See `isServerActionRequest`. */
  isServerAction: boolean;
}

export interface RateLimitRule {
  policy: RateLimitPolicy;
  matches: (request: RequestDescriptor) => boolean;
  /**
   * Extra key material beyond the client's identity.
   *
   * Omitted, every request matching the rule shares one bucket per client —
   * which is what the authentication and Server Action rules want. The API
   * rules supply the pathname, so that a client exhausting its budget on
   * `/api/photos` is not thereby refused on `/api/posts`; those are different
   * resources and sharing one counter between them makes the limit depend on
   * which pages the user happened to visit.
   */
  scope?: (request: RequestDescriptor) => string;
}

const MINUTE = 60_000;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const AUTHENTICATION_POLICY: RateLimitPolicy = {
  name: "authentication",
  limit: 10,
  windowMs: MINUTE,
  because:
    "every request under this policy is one guess at a password. Ten a minute is more than a person who has forgotten theirs will make and far less than an attack needs; argon2 makes each attempt expensive for the server too, so this is a CPU budget as much as a credential one",
};

export const SERVER_ACTION_POLICY: RateLimitPolicy = {
  name: "server-action",
  limit: 120,
  windowMs: MINUTE,
  because:
    "a Server Action is a mutation, and two a second sustained for a minute is not a person clicking. Generous rather than tight because this bucket is shared by every action on every page and is keyed by address, so an office behind one NAT gateway shares it",
};

export const API_WRITE_POLICY: RateLimitPolicy = {
  name: "api-write",
  limit: 60,
  windowMs: MINUTE,
  because:
    "the write half of the JSON API, per endpoint. It includes the HMAC-verified webhook at /api/revalidate, where the limit is what stops an unauthenticated caller spending the server's time on signature checks",
};

export const API_READ_POLICY: RateLimitPolicy = {
  name: "api-read",
  limit: 300,
  windowMs: MINUTE,
  because:
    "reads are cheap and the paginated endpoint is driven by an infinite scroll, so this has to clear ordinary UI traffic by a wide margin. It is a ceiling on scraping, not on use",
};

export const AUTH_ENDPOINT_POLICY: RateLimitPolicy = {
  name: "auth-endpoint",
  limit: 120,
  windowMs: MINUTE,
  because:
    "everything under /api/auth that is not a credential attempt — the session endpoint a client polls on window focus, the CSRF token, the OAuth redirects. Refusing these breaks sign-in for a legitimate user, so the budget only has to stop a flood",
};

/**
 * Paths deliberately outside every budget, with the reason.
 *
 * `assert-rate-limit-coverage.ts` reads this list, so an endpoint can only be
 * exempt by being written down here — the gate does not accept "no rule matched"
 * as an answer.
 */
export const RATE_LIMIT_EXEMPT: readonly { path: string; because: string }[] = [
  {
    path: "/api/health",
    because:
      "a liveness probe answered with 429 is an instance the orchestrator marks unhealthy and restarts, so limiting this endpoint converts a burst of probes into an outage. It reads nothing, touches no database and returns a constant; there is no cost here worth defending",
  },
];

/**
 * The rules, in precedence order. First match wins.
 *
 * Order matters twice: the credential rules are ahead of the general
 * `/api/auth` rule, and every `/api` rule is ahead of the Server Action rule,
 * because a POST to `/api/...` is not a Server Action but the fallback would
 * not know that.
 */
export const RATE_LIMIT_RULES: readonly RateLimitRule[] = [
  {
    // NextAuth's own credentials endpoint. Reachable directly — a client that
    // fetches /api/auth/csrf first can post to it all day — and it was outside
    // the proxy's matcher entirely until this feature widened it.
    policy: AUTHENTICATION_POLICY,
    matches: ({ method, pathname }) =>
      method === "POST" && pathname.startsWith("/api/auth/callback/"),
  },
  {
    // The same password check reached through `loginAction` / `registerAction`,
    // which are Server Actions posted to the page's own path.
    policy: AUTHENTICATION_POLICY,
    matches: ({ isServerAction, pathname }) =>
      isServerAction && (pathname === "/login" || pathname === "/register"),
  },
  {
    policy: AUTH_ENDPOINT_POLICY,
    matches: ({ pathname }) => pathname.startsWith("/api/auth/"),
  },
  {
    policy: API_WRITE_POLICY,
    matches: ({ method, pathname }) =>
      WRITE_METHODS.has(method) && isApiPath(pathname),
    scope: ({ pathname }) => pathname,
  },
  {
    policy: API_READ_POLICY,
    matches: ({ pathname }) => isApiPath(pathname),
    scope: ({ pathname }) => pathname,
  },
  {
    policy: SERVER_ACTION_POLICY,
    matches: ({ isServerAction }) => isServerAction,
  },
];

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function isExempt(pathname: string): boolean {
  return RATE_LIMIT_EXEMPT.some((entry) => entry.path === pathname);
}

export interface SelectedPolicy {
  policy: RateLimitPolicy;
  /** The bucket, before the client identity is appended. */
  scope: string;
}

/**
 * The policy for a request, or `undefined` if nothing limits it.
 *
 * `undefined` is a real answer and the common one — a page navigation is not
 * counted, and `@/lib/rate-limit/enforce` skips the store entirely for it,
 * which is what keeps the limiter off the path of the traffic that makes up
 * most of the requests.
 */
export function selectPolicy(
  request: RequestDescriptor,
): SelectedPolicy | undefined {
  if (isExempt(request.pathname)) return undefined;

  for (const rule of RATE_LIMIT_RULES) {
    if (!rule.matches(request)) continue;
    const suffix = rule.scope?.(request);
    return {
      policy: rule.policy,
      scope: suffix ? `${rule.policy.name}:${suffix}` : rule.policy.name,
    };
  }

  return undefined;
}
