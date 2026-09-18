# Geo targeting and A/B routing

One URL, two pages, one decision per visitor — made in the proxy, kept in a
cookie, and invisible in the address bar.

`/pricing` is the worked example. Half the traffic in six countries sees a
layout that leads with the annual price; everyone else sees the one that leads
with the monthly price. Both are prerendered static documents, neither ships a
line of JavaScript to choose between them, and the URL is `/pricing` for
everybody.

```
src/lib/experiments/
├── definitions.ts   the registry: arms, weights, targeting, routes
├── hash.ts          visitor → bucket, deterministically
├── geo.ts           which country header to believe, and when
├── cookies.ts       the two cookies, and the format of the second
├── assignment.ts    the precedence rules: override → cookie → targeting → hash
├── routing.ts       assignment → rewrite target
└── edge.ts          the only module that touches a request
src/proxy.ts         calls two functions from edge.ts
src/app/pricing/     the canonical page (control) and v/[variant] (the rest)
scripts/assert-experiment-wiring.ts   the CI gate over all of it
```

## The request

```
GET /pricing
  ↓ proxy.ts
  rate limit            ← unchanged, still first
  session gate          ← unchanged, still second
  resolveExperimentContext(request)
      visitor id     ← cookie bkt_vid, or minted
      country        ← x-vercel-ip-country / cf-ipcountry
      assignments    ← cookie bkt_exp, or hashed
      rewrite?       ← /pricing → /pricing/v/annual-first
  applyExperiments(request, context, gateResponse)
      NextResponse.rewrite(...)  or  NextResponse.next(...)
      + Set-Cookie (only when something changed)
      + x-experiment-exposure: pricing-cta:annual-first
  ↓
/pricing/v/annual-first  — a prerendered static document
```

## Why a rewrite and not a redirect

A redirect puts the arm in the address bar. From there it goes into the
visitor's history, into the link they paste into a chat, into whatever your
analytics calls a page path, and into a search engine's index as a second URL
with near-identical content. A rewrite changes what renders and nothing else.

The variant pages are still reachable directly, on purpose — it is how you open
both arms side by side — so they carry `robots: { index: false }`.

## Why the canonical path is a real page

`/pricing` is not a stub that only exists to be rewritten. It renders the
control arm itself, and the registry says so:

```ts
route: {
  path: "/pricing",
  canonicalVariantId: "control",
  rewritePrefix: "/pricing/v",
}
```

So the proxy only rewrites the _other_ arms, and the failure mode of the whole
feature is "everybody sees the layout we already had". If the proxy does not run
— a preview deployment, a matcher change, a future Next release that renames the
file convention again — `/pricing` still answers with a pricing page. The
alternative, where every visitor is rewritten and the canonical path holds
nothing, answers 404 the moment bucketing stops.

## Why the assignment is stored, when the hash is deterministic

This is the part the phrase "cookie-stable" is about, and it is the one people
skip.

`hashToBucket(visitorId + experimentId + salt)` is stable with respect to the
_visitor_. It is not stable with respect to the _experiment_. Change a weight
from 50/50 to 70/30 and every bucket boundary moves — so a fifth of the people
already in the treatment silently become controls. They have seen the treatment.
Some of them converted on it. Their later sessions are now counted in the other
arm.

Nothing fails when that happens. No error, no broken page, and the dashboard
keeps filling in with a number that is wrong.

So the resolved arm is written to `bkt_exp`, and on every later request the
cookie wins over the hash. A weight change then applies to new visitors only,
which is the only way a weight change is safe to make mid-flight.

## Precedence

`resolveAssignments` answers in this order, per experiment:

| Order | Source            | Persisted? | Counted? | Why it is where it is                                                                                                                                                                                                                                                                 |
| ----- | ----------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `?bkt_<id>=<arm>` | no         | **no**   | Anyone can send it. It exists so a reviewer can open both arms in two tabs and a bug report can name the arm it was seen in. It must be able to change what one person sees and must not be able to move the numbers — so it is marked unexposed and kept out of the exposure header. |
| 2     | `bkt_exp` cookie  | yes        | yes      | Wins even against targeting: a visitor who was bucketed in a targeted country and has since travelled keeps their arm, because moving them would put one person's sessions in both arms. Only an arm the experiment no longer has is discarded.                                       |
| 3     | targeting         | **no**     | no       | Failing the country list means _not in the experiment_, not "assigned to control". Persisting it would pin the visitor to the fallback for a year because of one trip.                                                                                                                |
| 4     | hash              | yes        | yes      | Everyone else.                                                                                                                                                                                                                                                                        |

## Geo, and how much of it to believe

There is no `request.geo` any more — Next 15 removed it and Next 16 has not
brought it back. The country is a header, and which header you may believe is a
deployment fact:

| Header                | Trusted                                       | Why                                                                                             |
| --------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `x-vercel-ip-country` | always                                        | Vercel sets it at the edge and strips a client-supplied copy.                                   |
| `cf-ipcountry`        | always                                        | Cloudflare, same.                                                                               |
| `x-geo-country`       | only with `EXPERIMENTS_TRUST_FORWARDED_GEO=1` | Nothing strips it. On a deployment without an edge in front, this is a value the browser typed. |

When both platform headers are present — Cloudflare in front of Vercel — the
_innermost_ one wins, because it was written last, by the hop closest to this
process, and cannot have been forged by the layer outside it.

`XX` (Cloudflare's "could not geolocate") and `T1` (Tor) are mapped to `ZZ`,
because they match `/^[A-Z]{2}$/` and would otherwise be compared against a
targeting list as though they were countries.

An experiment that lists countries excludes unknown traffic. On a deployment
with no geo header at all that puts _all_ traffic in the fallback arm — which is
the correct reading of "run this only in these six countries" when the platform
cannot tell you the country, and is why the wiring gate prints what it found.

**Targeting is not a geofence.** Self-selecting into an arm skews it by one
visitor and the `forced` flag already accounts for that. Tax, currency, export
controls, age gates and content licensing are a different question and do not
belong on a header the caller can influence.

## The headers, and the one that is a security boundary

The proxy forwards two request headers to the application:

| Header                     | Value                           |
| -------------------------- | ------------------------------- |
| `x-geo-country`            | `US`, or `ZZ`                   |
| `x-experiment-assignments` | `pricing-cta:annual-first:hash` |

and sets one response header, on the canonical path, for analytics and CDN
logs:

| Header                  | Value                                                  |
| ----------------------- | ------------------------------------------------------ |
| `x-experiment-exposure` | `pricing-cta:annual-first` — measured assignments only |

Next merges proxy-set request headers and client-sent request headers into one
`Headers` object, with nothing marking which is which. A request arriving with
its own `x-experiment-assignments: admin-ui:on:hash` would therefore be read by
the application as though the proxy had decided it. So `sanitisedRequestHeaders`
deletes every entry of `INTERNAL_REQUEST_HEADERS` from the inbound request
before setting its own — on every path, including the ones that take no part in
bucketing, where the deletion is the entire point. The wiring gate asserts that
the deletion is a loop over the constant rather than a list of named headers,
because a list goes on passing after a header is added to the constant and not
to the list.

## Reading the assignment in the application

You almost certainly should not.

`headers()` in a Server Component makes the route dynamic. Both arms of
`/pricing` are prerendered static documents precisely because the variant is
decided in the proxy; reading the assignment header in the page would give up
the prerender and keep the rewrite — the worst of both. The variant arrives as a
prop, from the path the proxy rewrote to.
`scripts/assert-experiment-wiring.ts` fails on a `cookies()`, `headers()`,
`draftMode()` or `auth()` call anywhere under an experiment's route subtree.

Where it is legitimate is a route handler, which is dynamic already:

```ts
const assignments = request.headers.get("x-experiment-assignments");
// "pricing-cta:annual-first:hash"
```

## Caching, and the `Vary` header you cannot send

The canonical path answers differently for two requests that differ by nothing
but a cookie, and `next build` gives the prerendered `/pricing`
`Cache-Control: s-maxage=31536000`. A year, in a shared cache, keyed on the URL.
A CDN in front of this application would store whichever arm the first visitor
after a purge happened to get and hand it to everyone behind it — and the
experiment would go on reporting a difference between two populations that were
never split.

`Vary: Cookie` is the correct HTTP answer to that, and **Next will not let you
send it.** It writes its own `Vary` on every App Router response — `rsc,
next-router-state-tree, next-router-prefetch, next-router-segment-prefetch,
Accept-Encoding` — and that value replaces whatever came before it. Verified on
a production build, both ways:

| Set from                                   | Other headers set alongside it                        | `Vary: Cookie` arrived? |
| ------------------------------------------ | ----------------------------------------------------- | ----------------------- |
| the proxy, on the rewrite's `NextResponse` | `x-experiment-exposure` arrived intact                | no                      |
| `next.config.ts` `headers()`               | a probe header **and** a `Cache-Control` both arrived | no                      |

So `Vary` is not an available mechanism here, and a `Vary: Cookie` written
anywhere in this codebase would be a line that reads like a protection and is
discarded before it reaches a cache. `edge.ts` says so where someone would
otherwise add it back.

`Cache-Control` _is_ settable — the second row is the proof — so the canonical
path declares itself uncacheable by shared caches, from `next.config.ts`:

```
Cache-Control: private, max-age=0, must-revalidate
```

`private` is the half that matters: a shared cache may not store the response
at all. `max-age=0, must-revalidate` lets the browser keep its copy and
revalidate against the `ETag` Next already sends, so a repeat visit is a 304
rather than a full document — the arm is stable, so the cached copy is almost
always still right, and a retired experiment is what the revalidation notices.

The cost is real: the canonical path is no longer served from a CDN edge. It is
one path, the document is small and static, and the variant pages it rewrites to
keep their own long-lived cache entries under their own URLs.

The rule is written out in the config rather than derived from the registry,
because `next typegen` compiles `next.config.ts` to CommonJS without the `@/`
alias — a call into `src/lib/experiments` builds fine and then fails typegen.
The wiring gate closes the gap from the other side: it holds the registry, reads
the config's `headers()` block as literals, and fails if a routed experiment's
canonical path is missing from it, sets no `Cache-Control`, sets one a shared
cache may store, or sets an `s-maxage` at all.

On Vercel this is belt and braces — middleware runs ahead of the cache lookup
there, so the rewritten path is what gets cached. It is not belt and braces for
the deployment shape this repository actually configures: `output: "standalone"`
behind an ordinary CDN, where nothing guarantees the proxy runs before the cache
does.

`Set-Cookie` is written only when something actually changed — a new visitor, a
new experiment, a retired one. A cookie on every page view is a header on every
page view and, in some caches, a reason not to store a response at all.

## The cookies

| Cookie    | Holds                      | Attributes                                                            |
| --------- | -------------------------- | --------------------------------------------------------------------- |
| `bkt_vid` | `crypto.randomUUID()`      | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=1y`, `Secure` on HTTPS |
| `bkt_exp` | `pricing-cta:annual-first` | same                                                                  |

`HttpOnly` because nothing in the browser needs to read them: the arm is decided
in the proxy and rendered by the server, so client JavaScript reading the cookie
could only disagree with the page it is on — and an XSS cannot rewrite someone's
cohort.

`SameSite=Lax` rather than `Strict`: `Strict` withholds the cookie on every
cross-site navigation, which is exactly the traffic an experiment usually
measures — the visitor arriving from an ad, a search result or a link. They
would be minted a new id on arrival and counted as a new visitor every time.

`Secure` follows the request's scheme rather than being hard-coded, because a
`Secure` cookie set over `http://localhost` is discarded silently, which would
make every local page view a new visitor.

**Consent.** `bkt_vid` is a first-party identifier with no personal data in it
and a one-year lifetime. That is not automatically "strictly necessary" under
the ePrivacy directive, whatever the absence of personal data suggests. A
deployment with a consent banner should mint these behind it; the shape of that
decision is yours, and the code makes it easy — nothing else in the request path
depends on either cookie existing.

## The hash

FNV-1a, then murmur3's `fmix32`, then `% 10_000`.

- **Not `Math.random()`**, which re-rolls per request, so one visitor sees both
  arms and the experiment measures nothing.
- **Not a counter**, which is stable only if every request for a visitor reaches
  the same process, and which makes assignment a function of arrival order — so
  an arm can correlate with time of day.
- **Not `crypto.subtle`**, which is asynchronous, on a path that runs for every
  page request. `node:crypto` would work and would pin this module to the Node
  runtime, which the rest of the request path here deliberately avoids.
- **`fmix32` is load-bearing.** FNV-1a has poor avalanche in the low bits, and
  `% 10_000` keeps exactly those. Without the finaliser, sequential ids — what a
  database-issued visitor id looks like — bucket visibly unevenly.

The modulo is biased by about 1 part in 590,000. Rejection sampling would remove
it and would make the function a loop with an unbounded worst case on the
request path; the bias is four orders of magnitude below the sampling noise of
any experiment this would be used for.

`hash.test.ts` pins the buckets of four known seeds. Changing the algorithm
re-buckets every visitor already in an experiment, so that test failing is the
question "do you mean to restart every live experiment?" being asked out loud.

**Bucketing is not a security boundary.** The algorithm is in this repository
and the id is in the visitor's own cookie, so anyone can compute their bucket
and try ids until they get the arm they want. Fine for a call to action. Not
fine for gating a paid or unreleased feature — gate those on the session,
server-side.

## Adding an experiment

1. Add it to `EXPERIMENTS` in `src/lib/experiments/definitions.ts`. Weights are
   basis points and must sum to 10,000; `validateRegistry` throws at module load
   otherwise, and the wiring gate prints every problem at once.
2. If it changes a URL, give it a `route` and build the pages: a canonical page
   rendering `canonicalVariantId`, and `<rewritePrefix>/[variant]` with a
   `generateStaticParams` over the arms, a `notFound()` for anything else, and
   `robots: { index: false }`. Each segment needs `loading.tsx` and `error.tsx`;
   both arms must render the _same_ frame, or the arm is visible before the page
   resolves.
3. Add the page-side arm list and register it in `VARIANT_LISTS` in
   `scripts/assert-experiment-wiring.ts`.
4. Add both routes to `EXPECTED_ROUTES` in `scripts/assert-route-shape.ts` and
   to `ROUTE_BUDGETS` in `scripts/assert-bundle-budget.ts`.
5. Add a `headers()` rule for the canonical path in `next.config.ts` with
   `Cache-Control: private, max-age=0, must-revalidate`.

Steps 3, 4 and 5 are checked: a routed experiment missing from any of those
tables fails the wiring gate.

## Why there is a gate at all

Every way this feature breaks produces a working application.

- Delete the two calls from `src/proxy.ts` and every visitor is served the
  canonical page. That is the designed failure mode, so nothing fails — the
  treatment arm simply stops receiving traffic, which looks exactly like an
  experiment nobody has reached yet.
- Add a third arm and forget the page, and that arm's share of traffic gets a 404. The registry is valid, the weights sum, the types check.
- Drop the `headers.delete` loop and the application starts believing a header
  any client can send. Nothing changes for anyone who is not attacking it.
- Read the assignment in the page and both arms stop prerendering, while
  continuing to render correctly.
- Drop the `headers()` rule and the canonical path goes back to
  `s-maxage=31536000`. `next dev`, `next start` and a preview have no CDN in
  front of them, so nothing about it is visible until it is production-only.

`pnpm exec tsx scripts/assert-experiment-wiring.ts` fails on all five. Every
rule was checked against the failure it names in this tree, not only against
fixtures — including one that found a bug in the gate itself: the `robots` rule
was first written as a regular expression over the file text and passed on a
page whose metadata said `index: true`, because the doc comment above the export
quotes the rule it describes. It reads the syntax tree now.

## Environment

```
# Read x-geo-country from the incoming request. Only set this when an edge you
# control overwrites that header — otherwise it is a value the browser typed.
EXPERIMENTS_TRUST_FORWARDED_GEO=
```
