# Rate limiting

Server Actions and route handlers are counted in `src/proxy.ts`, before routing,
before the session is read, and before any database connection is opened. The
budgets are a table in `src/lib/rate-limit/policy.ts`, and
`scripts/assert-rate-limit-coverage.ts` fails the build if an endpoint exists
that the proxy cannot see or that no rule covers.

## "At the edge" is not available in Next 16

The spec item asks for this at the edge. There is no edge runtime here to put it
on, and that was read in the framework rather than assumed:

- The proxy always runs on Node. `next/dist/build/analysis/get-page-static-info.js`
  rejects a runtime segment config in that file outright — _"Route segment
  config is not allowed in Proxy file … Proxy always runs on Node.js runtime."_
  — and the build records it: `.next/server/functions-config-manifest.json`
  lists `/_middleware` with `"runtime": "nodejs"`.
- Route handlers cannot declare one either, for the separate reason
  `src/lib/api/runtimes.ts` documents: `cacheComponents` is on repo-wide and
  rejects the `runtime` export for `"edge"` and `"nodejs"` alike.

So nothing in this application runs on the edge runtime. What the item is
actually about survives: the limit is applied at the first point a request
reaches, which is the property that decides whether a flood costs anything. The
module graph under `src/lib/rate-limit/` is kept to the Fetch API and
`next/server` regardless, so it moves without a rewrite the day a choice exists,
and the coverage gate prints the runtime the build used so a change is noticed.

## The budgets

| Policy           | Limit   | Applies to                                                               |
| ---------------- | ------- | ------------------------------------------------------------------------ |
| `authentication` | 10/min  | `POST /api/auth/callback/*`, and Server Actions on `/login`, `/register` |
| `auth-endpoint`  | 120/min | the rest of `/api/auth/*`                                                |
| `api-write`      | 60/min  | `POST`/`PUT`/`PATCH`/`DELETE` under `/api`, per endpoint                 |
| `api-read`       | 300/min | everything else under `/api`, per endpoint                               |
| `server-action`  | 120/min | every other Server Action                                                |
| —                | none    | page navigations, and `/api/health`                                      |

Each row carries its `because` in the source. Two of them are worth repeating
here because they are decisions rather than numbers:

**Page navigations are not limited.** Next prefetches every `<Link>` that
scrolls into view, so a reader scrolling a list issues dozens of GETs without
touching the keyboard. A budget low enough to be a defence would refuse the
framework's own traffic; a budget high enough not to would not be a defence.
Volumetric protection for reads belongs in a CDN or WAF, which can apply it
without knowing what a Server Component is. What is limited here is what costs
something and what no CDN can classify: mutations, credential attempts, and the
API.

**`/api/health` is exempt.** A liveness probe answered with 429 is an instance
the orchestrator marks unhealthy and restarts, so limiting it converts a burst
of probes into an outage.

## The bug this closed

`config.matcher` in `src/proxy.ts` excluded `api/auth`, with a comment
explaining that OAuth callbacks must not be gated by the session check. The
comment was right about the intent and the mechanism was wrong: excluding a path
from the matcher excludes it from the **whole proxy**, not from the session
check.

`POST /api/auth/callback/credentials` is the password check. It is reachable
directly — `GET /api/auth/csrf` returns a token and sets the cookie that matches
it, and from there a client can post credentials as fast as it likes. Every
attempt ran a full argon2 verification, and none of it reached any code that
could count it.

The matcher now covers `/api/auth`, and the exclusion lives in `isAuthEndpoint`
in `src/proxy.ts`, where it skips the session read and nothing else. The
credential Server Actions on `/login` and `/register` share the _same_ bucket as
the callback, so alternating between the two doors does not buy twice the
attempts.

## `X-Forwarded-For` is written by the client

This is where rate limiters are usually broken. Any client can send
`X-Forwarded-For: 1.2.3.4`, and each proxy in front of the application
**appends** the address it observed, so the header that arrives is:

```
<whatever the client made up>, <client as proxy 1 saw it>, <proxy 1 as proxy 2 saw it>, …
```

The leftmost entry is therefore the least trustworthy value in the request, and
`xff.split(",")[0]` — the version in most examples — hands the attacker the key
the limiter counts on. They send a different value each time and the limit is
not a limit.

`src/lib/rate-limit/client-identity.ts` counts back from the right instead. With
`RATE_LIMIT_TRUSTED_PROXIES=n`, the client is at index `length − n`. Set it to
the number of proxies that append to the header between the client and this
process:

| Deployment                                | Value                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| Node behind one CDN, load balancer, nginx | `1` (the default)                                                                          |
| CDN in front of a load balancer           | `2`                                                                                        |
| Directly exposed (no proxy)               | leave unset — there is no header to read, and every request shares the unidentified bucket |

When the chain is shorter than `n` claims, the rightmost entry is used rather
than the leftmost: it is the only one an attacker could not have written, so a
misconfiguration degrades towards over-counting instead of silently restoring
the bypass.

`x-real-ip` is consulted only when `x-forwarded-for` is absent entirely, so the
header a client can add never displaces the one our infrastructure writes.

## One IPv6 host is not one IPv6 address

A residential or datacentre IPv6 customer is routinely allocated a /64 or
larger. Keying on the full /128 lets a single machine spend every budget here as
many times as it likes by binding a new source address per request — the
counters would be perfect and the limit decorative. IPv6 addresses are truncated
to their /64 prefix, which is the smallest unit that generally corresponds to
one subscriber. IPv4 is used whole, and the IPv4-mapped form (`::ffff:203.0.113.9`)
is reported as the IPv4 address it is, so a dual-stack listener does not collapse
the entire IPv4 internet into a single bucket.

## Detecting a Server Action

Next sends a `Next-Action` header when the browser has JavaScript and calls the
action through its client runtime. It does **not** send one for the
progressive-enhancement path, where a plain `<form action={…}>` submits without
JavaScript — and it does not send one for `curl`, which is what an attacker
uses. A limiter keyed on that header alone is bypassed by omitting the header.

So the check is the header **or** a POST to a path that is not under `/api`. The
second half is structural, not a heuristic: in an App Router application there
is no way to POST to a page path except a Server Action.

## The counting algorithm

A sliding window counter (`src/lib/rate-limit/window.ts`): two counters per key —
this window and the last — with the previous one weighted by how much of it still
overlaps the trailing window from now.

```
estimate = previous × (1 − elapsed / windowMs) + current
```

A **fixed** window resets on a wall-clock boundary, so a caller who spends its
whole budget in the last instant of one window and again in the first instant of
the next has made twice the limit inside a span shorter than one window — for a
login endpoint at ten a minute, twenty password attempts in under a second. A
sliding window **log** is exact and stores one timestamp per request, which
makes the memory an attacker can force the limiter to allocate proportional to
the traffic they send. This is three numbers per key, with no boundary burst.

Refused requests are not counted. Counting them would let a caller who keeps
hammering hold themselves out past the window they were due to be readmitted
in, which turns a rate limit into an escalating ban.

### `Retry-After` is not the end of the window

The obvious value for `Retry-After` is the end of the current window, and it is
wrong — this feature shipped with it, and the bug was found by obeying its own
header against a running server: spend the credential budget, sleep for the
`Retry-After` you were handed, retry, get a second 429.

The reason is the same one that makes a sliding window a sliding window. At the
boundary this window's count becomes the _previous_ count, still overlapping
almost entirely, so a caller arriving one millisecond into the next window is
still at the limit. The honest answer is the instant that count has decayed far
enough, which is the same linear equation solved a second time against the
window after the turnover. At ten a minute, that moves the answer from 60
seconds to 66 — the six seconds it takes a full window's ten to decay to nine.

So a decision carries two instants, and each header gets the right one:

| Field     | Header            | Meaning                                  |
| --------- | ----------------- | ---------------------------------------- |
| `retryAt` | `Retry-After`     | when one more request would get through  |
| `resetAt` | `RateLimit-Reset` | when the whole budget is available again |

`resetAt` is two windows out whenever the current window has counted anything,
for the same reason: the count has to become the previous count and then age
out of it.

## The store, and what the default one is not

`MemoryRateLimitStore` is **per process**. Four instances behind a load balancer
enforce four times every limit in this repository, because each counts only what
it saw; on a platform that runs the proxy as a serverless function, a fresh
instance has counted nothing at all.

That is a real limitation and not a reason to ship nothing — a per-process limit
still refuses the single-source floods that make up most of what hits a public
endpoint, and a boilerplate cannot assume a Redis. Swapping in a shared store is
one line. The interface is a single method, and the one property an
implementation must have is that the **read-modify-write is atomic**:

```ts
// src/lib/rate-limit/store.ts
export interface RateLimitStore {
  consume(
    key: string,
    budget: RateLimitBudget,
    now: number,
  ): Promise<RateLimitDecision>;
}
```

Exposing `get` and `set` instead would put the sequence in the caller, where two
concurrent requests interleave as read-read-write-write and the second write
erases the first — under exactly the concurrent load a limiter exists to handle,
and biased towards under-counting. Single-threaded JavaScript does not save an
implementation whose `get` is an `await`.

A Redis implementation runs the same algorithm inside a Lua script, or uses
`INCR` with `EXPIRE` on two window keys and reads both. Point `rateLimitStore`
at it:

```ts
// src/lib/rate-limit/store.ts
export const rateLimitStore: RateLimitStore = new RedisRateLimitStore(redis);
```

The in-memory store caps itself at 10,000 keys and evicts stale entries first,
then the least recently used. The cap is not optional: keys are derived from
client addresses, so an attacker with a range chooses how many exist, and an
unbounded `Map` turns a rate limiter into the memory-exhaustion vector it was
installed to prevent.

## Response headers

Every counted response carries the IETF `RateLimit-*` fields
(draft-ietf-httpapi-ratelimit-headers), including the ones that were **allowed** —
a client that can see its remaining budget can slow itself down, while one that
only learns about the limit by hitting it can only retry into it.

```
RateLimit-Limit: 10
RateLimit-Remaining: 7
RateLimit-Reset: 43
RateLimit-Policy: 10;w=60
```

A refusal adds `Retry-After` and answers 429. Under `/api` the body is the same
`{ error: { code, message } }` envelope every other failure from
`src/lib/api/errors.ts` uses, with `code: "too_many_requests"`; everywhere else
it is `text/plain`.

## What is not done

**A refused Server Action does not reach its form.** The proxy cannot synthesise
a React Flight payload, so a 429 arrives as a failed request rather than an
`ActionResult` carrying a sentence, and `useActionState` surfaces it through the
segment's `error.tsx` instead of under the input. Fixing that means applying the
limit a second time _inside_ the action factory, where the result channel
exists — a `rateLimit` leg on `defineAction` alongside `idempotency`, keyed by
`userScope(user)` rather than by address. That second tier is also what a
per-user budget needs: an office behind one NAT gateway shares one bucket here,
which is the cost of keying on the network.

**Nothing is tested end to end.** The suite covers the algorithm, the identity
resolution, the policy table, the enforcement point and the proxy's wiring, all
as units. Asserting a real 429 against a running server needs the server plus
control over its clock, which is a larger piece of harness than this item.
