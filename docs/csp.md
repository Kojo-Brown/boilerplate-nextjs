# Content Security Policy

`src/proxy.ts` sets a policy on every response. It is built by
`src/lib/security/csp.ts`, which is pure, and turned into a per-request decision
by `src/lib/security/apply.ts`. `scripts/assert-csp.ts` fails the build if the
policy would refuse this application's own scripts, and `e2e/csp.spec.ts` checks
the same thing in a real browser.

The short version:

| document                                                                                               | how its scripts are authorised                                                    |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| rendered during the request (a PPR route's dynamic holes, an ISR miss, every page in `next dev`)       | `'nonce-…'`, minted per request                                                   |
| prerendered at build time and never regenerated (`/`, `/login`, `/photos`, `/pricing`, the PPR shells) | one `'sha256-…'` per inline script, emitted from the build output                 |
| re-rendered at runtime and cached (`/blog`, `/blog/[slug]` — anything with a revalidation window)      | `'unsafe-inline'`, no nonce, no digests, and every other directive still enforced |

The third row is not a shortcut. It is what is left after two measurements, both
below.

## Where the nonce reaches, and where it does not

Next takes the nonce from the **request's** `Content-Security-Policy` header —
`parseRequestHeaders` in `next/dist/server/app-render/app-render.js` — and hands
it to the renderer, which stamps it on every script it writes. That happens
during a render. A prerendered document is not rendered during the request; it is
a file on disk, written when no request and no nonce existed.

Measured on this application, Next 16.2.12, production build, one request each
with a distinct nonce in the request policy:

| request                                                     | script tags | nonced |
| ----------------------------------------------------------- | ----------- | ------ |
| `/` (static)                                                | 18          | 0      |
| `/blog` (ISR, prerendered)                                  | 24          | 0      |
| `/dashboard` (PPR: shell + streamed)                        | 20 + 24     | 24     |
| `/blog/<unprerendered slug>` (ISR miss, rendered on demand) | 17          | 17     |
| `/` under `next dev`                                        | 36          | 36     |

So a nonce-only policy works perfectly in development and breaks every public
page in production. That is the shape of mistake this repository builds gates
for: the build exits 0, every unit test passes, the HTML paints, and nothing
hydrates.

## Why there is no `'strict-dynamic'`

The spec item asked for one. `'strict-dynamic'` makes a browser ignore every
host source in `script-src` — `'self'` included — and allow only scripts carrying
the nonce or a matching hash, plus what those scripts insert themselves. Every
prerendered document here loads its chunk graph through 13–18 parser-inserted
`<script src="/_next/static/…">` tags, and by the table above those tags carry no
nonce.

Added to the policy, `'strict-dynamic'` therefore refuses **451 external script
tags across the 31 prerendered documents** — measured by
`scripts/assert-csp.ts`, which is what makes that number an assertion rather than
a claim. The gate names the keyword as forbidden _and_ reports the count it would
block, so the reason survives independently of the rule.

The only way to have `'strict-dynamic'` is to stop prerendering documents, which
would undo the route shapes `scripts/assert-route-shape.ts` exists to protect —
ISR on the blog, the PPR shells, the five static routes — and is a much larger
decision than a security item is entitled to make on its own.

## Why the digests come from the build output

The inline scripts in a prerendered document are Next's own: the bootstrap line
(`(self.__next_f=self.__next_f||[]).push([0])`), the flight payload of everything
the page rendered, and `next-themes`' pre-paint theme script. Their content
contains chunk filenames and the page's own markup — 183 of them across the
documents of one build, 94 distinct digests — so a committed list would go stale
on a copy edit, and the symptom would be a page that paints and never hydrates.

So `pnpm build` runs `scripts/emit-csp-hashes.ts` after `next build`. It reads
the HTML the build just wrote, hashes every inline script, and writes
`.next/csp-shell-hashes.json`; `src/lib/security/shell-hashes.ts` reads that file
once per process and resolves a request path against it. Three lookups are
needed and all three exist for a reason:

- **an exact path** — `/`, `/pricing/v/control`: a document on disk;
- **a dynamic route's regex** — `/blog/[slug]` has a fallback shell served for
  slugs the build did not enumerate, so the lookup uses the `routeRegex` the
  prerender manifest recorded;
- **universal** — `_not-found` and `_global-error` answer URLs that match
  nothing, so they cannot be looked up by path at all. Their ~8 digests go on
  every response. Without them a 404 is a page whose scripts are refused.

A rewritten request is looked up twice, under the requested path and the rendered
one: `/pricing` serves `/pricing/v/control`, and it is the variant's document
whose scripts have to be authorised.

The manifest is not in the standalone trace, so the `Dockerfile` copies it
explicitly. A production server that cannot find it logs one error and sends the
policy **report-only** rather than enforcing a policy that refuses everything —
an outage is not a safer default — and `scripts/assert-csp.ts` is what stops a
build reaching that state.

## The ISR finding: a nonce gets baked into the cache

`/blog` revalidates every 60 seconds. Next re-renders it at runtime using the
headers of whichever request triggered the revalidation — nonce included — and
stores the HTML. Measured: `.next/server/app/blog.html`, written at 01:20:28 by
the build, was rewritten at 01:27:51 by a revalidation, and the stored copy
carried `nonce="OdpfD9ah6T/VpP8gezgfkA=="` on all 24 of its script tags. Two
later requests, with `'nonce-AAAAAAAAAA'` and `'nonce-BBBBBBBBBB'` in their own
policies, were both answered with that same document.

Under an enforcing nonce policy, every visitor after the one that repopulated the
cache is served a page whose scripts their own policy refuses. The digests do not
help either: the regenerated document had eight inline scripts no digest from
that build covered.

Both halves of the strict policy are therefore unavailable for a document Next
re-renders at runtime, and the third row of the table at the top is what is left:

```
script-src 'self' 'unsafe-inline'
```

with no nonce and no digests — deliberately, because a CSP3 browser ignores
`'unsafe-inline'` as soon as either is present, so keeping one alongside it
reaches the same outage by a longer route. The nonce is not merely left out of the
policy: `decideCsp` withholds it, so nothing forwards it on the request and the
next revalidation writes a nonce-free document.

What is still enforced on those paths: `default-src 'self'`, `object-src 'none'`,
`base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, and
`script-src 'self'` — so an injected `<script src="https://…">`, an `<object>`, a
rewritten `<base>` and an off-site form target all still fail. What is given up
is inline script, on the two route patterns whose HTML Next regenerates.

Which paths those are is **derived, not declared**:
`scripts/emit-csp-hashes.ts` reads `initialRevalidateSeconds` out of the
prerender manifest, and `scripts/assert-csp.ts` re-derives it and fails if the
emitted manifest disagrees in either direction. Adding `export const revalidate`
to a page moves that page onto the relaxed policy with nothing to remember;
removing it moves the page back.

If you want the strict policy everywhere, the move is to stop caching whole
documents — keep the data cached with `use cache` and let the document render per
request, which nonces every script in it. That is a deliberate architectural
change; see `docs/partial-prerendering.md`.

## The one violation the enforced policy produced

With the policy enforced, the landing page reported exactly one violation:
`script-src blocked eval`, from a shared chunk, on every page load. Traced by
patching `window.Function` and reading the stack: `$ZodObjectJIT` — Zod v4
decides whether to JIT-compile an object validator by calling `new Function("")`
inside a `try`, when the schema is constructed.

Nothing was broken. The throw is caught, Zod falls back to its interpreted path,
the page hydrates, the theme toggle works, no `pageerror` is raised. What it cost
was the report: a browser fires `securitypolicyviolation` for a _caught_ `eval`
exactly as it does for a real injection, so a deployment with a reporting
endpoint would collect one violation per page view, indistinguishable from
something worth waking up for.

The fix is Zod's own escape hatch, which exists for this case —
`src/lib/security/zod-jitless.ts` sets `jitless` in the browser and leaves the
JIT fast path on the server. It has to run **above** the schemas in its module,
because Zod reads the capability when a schema is constructed and memoises the
answer; `scripts/assert-csp.ts` checks both the call and its position, over the
modules that actually execute in a browser (the walk stops at `"use server"`,
since a client component importing a Server Action does not ship that action's
code to the browser).

`'unsafe-eval'` in production would have silenced the same report by giving up
the strongest half of the policy.

## Inline styles

`style-src` keeps `'unsafe-inline'`, and that is about attributes rather than
scripts. React renders `style={{…}}` as a `style` attribute — 30 of them on a
blog post — and an attribute has no nonce to carry; `next-themes`'
`disableTransitionOnChange` appends a `<style>` element from the client, inside a
prerendered document, where a per-request nonce cannot reach it either. Neither
can execute code: `script-src` forbids inline script outright.

The split into `style-src-elem`/`style-src-attr` would let the element half be
`'self'`-only, and is deliberately not used: Safari shipped `style-src-elem` late
enough that on older versions the split silently means "no inline styles at all",
which is a broken page in exchange for a directive that reads stricter.

## Third-party origins

Every origin in the policy comes from `src/lib/third-party/catalogue.ts` — the
same inventory `scripts/assert-third-party-scripts.ts` audits. `script` entries
go to `script-src` and `connect-src` (and only when the deployment has configured
them: no `NEXT_PUBLIC_PLAUSIBLE_DOMAIN`, no `https://plausible.io` in the
policy), `facade` entries to `frame-src`, `asset` entries to `img-src`. The gate
checks both directions: a catalogue host the policy omits is a feature that works
in review and is blocked in production, and an origin in the policy that no
catalogue entry names is a permission nothing recorded.

## Development

Two relaxations, both properties of the dev server rather than of this
application: `'unsafe-eval'`, because Turbopack's dev runtime and React's
development build evaluate module code from strings, and `ws:`/`wss:` in
`connect-src` for the HMR socket. `NODE_ENV === "development"` is the only value
that turns them on — a test run gets the production policy, which is the one
worth asserting against.

## Rolling it out

`CSP_REPORT_ONLY=1` sends the same policy in
`Content-Security-Policy-Report-Only`. Next reads the nonce out of that header
too, so a report-only deployment still gets nonced markup: the policy is complete
and enforced by nobody, which is the point of the mode.

## What the gate checks

`scripts/assert-csp.ts`, in the `build` job:

1. every inline script in every prerendered document is authorised — by digest,
   or by `'unsafe-inline'` on a regenerating path;
2. every external script tag in them is authorised — this is the check that
   measures `'strict-dynamic'`;
3. the manifest was emitted for _this_ build id;
4. no `'unsafe-inline'`, `'unsafe-eval'` or `'strict-dynamic'` in the strict
   policy; the relaxed policy has `'unsafe-inline'` and no nonce or digest beside
   it to make it inert;
5. the relaxation covers exactly the routes the prerender manifest says
   revalidate;
6. `default-src`, `object-src`, `base-uri`, `frame-ancestors` and `form-action`
   are present and as strict as they should be;
7. the policy and the third-party catalogue agree, in both directions;
8. `src/proxy.ts` still calls `decideCsp`, `applyCspRequestHeaders` **and**
   `applyCspHeaders` — the request half is the one whose absence is silent;
9. no module that runs in a browser probes for `eval`.

Each rule was checked against the failure it names: `'strict-dynamic'` added
(451 refusals), the emit step skipped (rule 3), one digest deleted (rule 1,
naming the document), `object-src` dropped (rule 6), `/blog` marked as fixed
(rule 5), and the Zod guard moved below its schema (rule 9).

## What a browser confirmed

`e2e/csp.spec.ts`, against a production build: zero violations and zero `eval`
probes on `/`, `/blog`, `/login`, `/register`, `/photos`, `/pricing`,
`/forbidden`, a 404 URL, `/upload`, `/images` and the rewritten `/pricing`; the
theme toggle still flips the class on `<html>`, proving the bundle ran; and on
`/dashboard`, signed in, 26 nonced script tags, no violation, and the per-user
content rendered — the one route where the digests and the nonce both have to be
right at once.
