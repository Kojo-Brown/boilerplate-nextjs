# Spec: boilerplate-nextjs

> Spec-driven. Mark `[x]` only after pushing.

## Phase 0 — Green Baseline (blocks all feature work)

- [x] Verify every dependency version actually exists on the registry and fix the ones that do not, then commit a lockfile — `next-auth@^5.0.0` was unsatisfiable (v5 is prerelease-only), `jsdom` and `@vitest/coverage-v8` were used but undeclared, and the `linux-musl-openssl-3.x.x` binary target does not exist (PR #18)
- [x] Get `install`, `typecheck`, `lint`, `test`, and `build` all passing locally from a clean clone — required a full Prisma 7 migration and an ESLint flat config, since there was no ESLint config at all and Next 16 removed `next lint` (PR #18)
- [x] Promote `workflow-templates/ci.yml` to `.github/workflows/ci.yml` and confirm it runs green on a PR — green on PR #18 with a Postgres service for the build job
- [x] Add a CI job matrix covering the supported Node version and fail the build on any warning — lint, typecheck, test, and build run on Node 22 and 24 with `fail-fast: false`; warnings fail via `--strict-peer-dependencies`, `--max-warnings 0`, `NODE_OPTIONS=--throw-deprecation`, and `pnpm run strict` (PR #20)
- [x] Compile TailwindCSS: there is no `postcss.config.*`, so `@tailwindcss/postcss` never runs and the application ships **unstyled** — `postcss.config.mjs` added; the bundle goes 1,103 → 34,240 bytes. With Tailwind actually running, three `@utility` rules turned out to have been reaching for something they could not express (`@utility primary` defines `.primary`, not `bg-primary`), so `bg-primary`, `text-primary-foreground`, `text-muted-foreground`, `bg-muted`/`hover:bg-muted` and `ring-border` still compiled to nothing across the landing page, both auth forms, the toast demo and the avatar; an `@theme inline` block publishing the existing tokens into Tailwind's `--color-*` namespace replaces them, verified in a browser to follow the `.dark` override. `scripts/assert-css-output.ts` now reads the built stylesheet in CI — checked against the failure it names by moving the config aside and rebuilding: `next build` exited 0, the gate exited 1 with 13 violations. The `/photos` grid measures three columns at 1280px, two at 700px, one at 500px, at a 3/2 aspect ratio; all 7 `e2e/photos.spec.ts` cases pass and the `shellMustContain` assertions were unaffected (PR #23)

**Phase 0 reopened (2026-08-17, found while building `/photos` in PR #22).**
The production CSS bundle is 1,103 bytes — the `:root` custom properties from
`globals.css` and nothing else. Not one Tailwind utility reaches the browser:
`.flex`, `.absolute`, `.grid-cols-3` and `aspect-ratio` are all absent, so
every page in the application renders as unstyled block flow. `next build` is
green, every unit test passes, and the route-shape gate is satisfied, because
none of them look at the stylesheet.

The cause is that `@tailwindcss/postcss` is in `devDependencies` but is never
wired up — the repository has no `postcss.config.mjs`, so Next hands
`@import "tailwindcss"` to Lightning CSS, which resolves it and drops the
directives it does not understand.

Verified during PR #22: adding

```js
// postcss.config.mjs
const config = { plugins: { "@tailwindcss/postcss": {} } };
export default config;
```

takes the bundle from 1,103 bytes to 33,686, and the `/photos` grid goes from
three zero-height boxes with viewport-filling images to a correct three-column
layout. It was left out of that PR because it restyles all 14 routes and is a
separate change from the routing item; it belongs here, ahead of feature work.
Re-check the `shellMustContain` assertions in `scripts/assert-route-shape.ts`
when landing it, and re-run `e2e/photos.spec.ts` — all seven cases pass against
a Tailwind-compiled build and cannot pass without one.

Phase 0 items 1-3 complete as of PR #18 (2026-07-30): install
(`--frozen-lockfile`, zero warnings), lint (0 errors, 0 warnings), format check
on changed files, typecheck, 223 unit tests across 28 files, and build all green
in CI on Node 22, with the build prerendering `/blog/[slug]` against a real
Postgres 16 service container.

**Phase 0 complete as of PR #20 (2026-08-01).** All eleven checks green on both
Node majors. Making warnings fatal forced two real fixes: `src/middleware.ts`
became `src/proxy.ts` (Next 16 renamed the file convention) and `vitest.config.ts`
moved off the deprecated `environmentMatchGlobs` onto named `dom`/`node`
projects. `pnpm run strict <cmd>` wraps commands that print warnings and still
exit 0; the build job now caches `.next/cache`.

**Phase 0 closed again as of PR #23 (2026-08-17).** Twelve checks green on both
Node majors. The reopened item is fixed and, more to the point, is now checked:
`scripts/assert-css-output.ts` reads the stylesheet the build wrote, so the
class of failure that produced a green build and an unstyled application cannot
recur silently. That gate was itself verified against the failure it names
rather than only against a passing build.

Known gaps carried into Phase 1: Prettier has never run repo-wide (~79
pre-existing offenders, so `format:check` gates only changed files); Playwright
E2E is still not wired into CI; there is no migrations directory, so CI uses
`prisma db push`; `workflow-templates/ci.yml` still holds the stale
pre-promotion copy; and the warning gate carries one documented exemption for
Next's cold-cache notice, which describes the runner rather than the code.

## Phase 1 — Foundation

- [x] Next.js 16 App Router + TypeScript 6 + TailwindCSS 4 scaffold
- [x] Prisma 7 + PostgreSQL schema (User, Session, Post) with seed
- [x] Zod-validated env vars (`src/lib/env.ts`)
- [x] Server Actions pattern with typed responses (`ActionResult<T>`)
- [x] Route groups: `(auth)` for login/register, `(dashboard)` for protected

## Phase 2 — Auth

- [x] NextAuth.js v5 (credentials + Google provider) with Prisma adapter
- [x] Middleware for protected routes (redirect to /login)
- [x] Session-aware server components via `auth()` helper
- [x] Role-based access: admin guard via middleware matcher

## Phase 3 — UI System

- [x] shadcn/ui-compatible component primitives (Button, Input, Card, Dialog)
- [x] Dark mode via `next-themes` with CSS variables
- [x] Toast notifications (Sonner)
- [x] Responsive nav layout with mobile drawer
- [x] Style the blog post body: `app/blog/[slug]/page.tsx` applies `prose prose-neutral`, but `@tailwindcss/typography` is not a dependency, so both classes compile to nothing and the post body renders with default paragraph spacing. Found while landing PR #23 and left out of it deliberately — adding a plugin is a dependency decision, not part of getting Tailwind to run. It is the one place the application is still knowingly unstyled. — plugin loaded at 0.5.20; `prose-neutral` replaced by `@utility prose-app`, which re-points every `--tw-prose-*` variable at the design tokens, because the plugin's fixed palettes are not `--foreground` and `dark:prose-invert` would have followed the OS rather than the theme toggle. `toParagraphs` splits the plain-text `Post.content` on blank lines, since prose's paragraph rhythm had one `<p>` and nothing to space. `.prose-app` outranks `.prose` only by emission order — same layer, same specificity — so the CSS gate now asserts that ordering alongside both classes. Measured in Chromium in both themes: 20px prose margin, 28px line-height, body colour equal to the computed `--foreground` under `.dark` as well as `:root` (PR #24)
- [x] Make the `dark:` variant track the theme toggle: `next-themes` is configured with `attribute="class"` and toggles `.dark` on `<html>`, but Tailwind v4's built-in `dark:` variant resolves to `@media (prefers-color-scheme: dark)` and this project never overrides it. So every `dark:` utility in the codebase — `dark:hover:bg-green-950` in `toast-demo`, `dark:bg-red-950/20` in `image-upload`, the published/draft badges in `post-card` and `posts-manager` — follows the operating system and ignores the toggle, in both directions: switching to dark leaves them light, and a dark-mode OS lights them up on a page the user has set to light. Declaring `@custom-variant dark (&:where(.dark, .dark *))` in `globals.css` is the fix, but it changes rendering everywhere those classes appear, so each needs looking at rather than a blanket flip. Found while landing the prose item above, which sidestepped the variant entirely by reading tokens through `var()`. — `@custom-variant dark (&:where(.dark, .dark *))` in `globals.css`. `:where()` rather than the shorter `.dark &` because specificity is load-bearing: `.dark &` compiles to (0,2,0), which beats the `bg-green-100` it is meant to override and beats unrelated single-class rules that should have won, while `:where()` contributes nothing and leaves the rule level with its light counterpart, settled on emission order like every other variant — verified on the built stylesheet, where all five pairs emit the dark rule after the light one. All eleven `dark:` declarations across the four components were written for a class toggle and needed no rewriting; each was measured rather than assumed, in Chromium across all four combinations of OS preference × html class, on two claims apiece (the value under `.dark` differs from the value without it, and for a fixed class the OS makes no difference): 11/11 pass, and 11/11 failed the identical probe before. The case reachable today, dark-mode OS with `theme=light` persisted, went from a white page carrying a `green-900/30` badge to a `green-100` one. System preference is not lost — `enableSystem` has `next-themes` read `prefers-color-scheme` itself and toggle the same class. `next build` exited 0 both before and after, so `REQUIRED_CLASS_KEYED_DARK` now reads the _condition_ each rule is emitted under: losing the one line leaves every utility still emitted at the same byte count, invisible to the required-utility list and the size floor alike. Checked against the regression it names — line removed and rebuilt, `next build` exited 0 and the gate exited 1 with 8 violations naming the media query (PR #25)
- [x] Mount the theme control: `ThemeToggle` (`src/components/ui/theme-toggle.tsx`) cycles system → light → dark through `next-themes` and has eight passing tests, and nothing in the application renders it — `grep -r ThemeToggle src` returns the component and its own test and nothing else. So the dark theme is currently unreachable by a user: the only inputs are the OS preference and a `localStorage.theme` value no UI writes. Found while landing the `dark:` variant item above, which the missing mount does not block — the variant is what makes `dark:` utilities follow the resolved theme however it was resolved — but which it does leave undemonstrable in the running app. The toggle needs a home in `app-shell.tsx` alongside `NavLinks`/`MobileDrawer`, reachable on both the public and dashboard shells, plus the hydration care a theme control needs: `theme` is `undefined` on the server, so a naive render mismatches. — mounted in all five shells: `app-shell.tsx` (the five dashboard routes), `blog/layout.tsx`, `photos/layout.tsx`, `(auth)/layout.tsx` and `page.tsx`. The last two are the ones the item's "public shells" phrasing does not cover, and they are the ones that matter most for reachability — `/` renders directly under the root layout and inherits no shell at all, and `/login`/`/register` are where a signed-out visitor arrives; neither has header chrome, so the control is pinned to the corner rather than left out. In `app-shell.tsx` it sits ahead of `headerSlot`, not after it: `headerSlot` is a streamed hole (`<UserChip>` behind Suspense), so the other order would slide the control sideways when the session resolved. The hydration care turned out to be the substantive half. `next-themes` seeds from `localStorage` in a lazy `useState` initialiser, so the first _client_ render already knows the theme while the server never can, and `suppressHydrationWarning` on `<html>` does not reach it — that covers the element's own attributes, which is what the provider's inline script rewrites, not descendants. The button therefore renders a neutral label and half-disc icon until `useIsHydrated()` flips (`false` on the server _and_ on the hydrating render, `true` from the commit on, so the two agree by construction — the same hook `MobileDrawer` already uses, which also keeps it clear of `react-hooks/set-state-in-effect`). Deliberately not `disabled`: nothing here is interactive pre-hydration, so singling this control out would only flash `disabled:opacity-50` on every load. `src/app/theme-control.test.tsx` asserts each of the five shells mounts it — that guard is the point of the item, since a component's own tests render it themselves and can never catch its absence from the application, which is exactly how this survived eight green tests for weeks. Verified beyond jsdom: `aria-label="Theme"` appears in the prerendered HTML of all five shells including the PPR dashboard ones, route shape is unchanged (14 expectations, the six static routes still static), and Chromium against `pnpm start` confirms the cycle, `.dark` landing on `<html>`, the paint changing, and persistence across `/` → `/blog`. 403 unit tests, up from 393; `e2e/theme.spec.ts` adds five browser cases but the e2e suite is still not wired into CI, so it did not gate the merge (PR #26)

## Phase 4 — Data Layer

- [x] Server components with Prisma direct queries (no API layer)
- [x] TanStack Query for client-side mutations + optimistic updates
- [x] Cursor-based pagination helper
- [x] Image upload with Next.js Server Actions + S3 presigned URLs

## Phase 5 — Performance

- [x] Route-level streaming with `loading.tsx` skeletons
- [x] `next/image` wrapper with blur placeholder + LQIP
- [x] Parallel routes for dashboard widgets
- [x] ISR (incremental static regen) example for public pages

## Phase 6 — Testing

- [x] Vitest + Testing Library for server/client components
- [x] Playwright E2E: auth flow, protected page, form submission
- [x] MSW for API route mocking in tests

## Phase 7 — DevOps

- [x] GitHub Actions: lint → typecheck → test → build
- [x] Dockerfile (standalone output mode)
- [x] Vercel config (`vercel.json`) + GitHub deploy action

## Phase 8 — Advanced App Router

- [x] Partial Prerendering: static shell + streamed dynamic holes, with a documented tradeoff guide — enabled via `cacheComponents` (there is no `experimental.ppr` in Next 16 and no incremental mode); found and fixed two invisible defects on the way, the root layout's `auth()` making every route dynamic and the dashboard layout's session read reducing its "static shell" to a `<title>` (PR #21)
- [x] Intercepting routes for a modal photo/detail view with a shareable URL — `@modal/(.)photos/[id]` renders a dialog on a soft navigation, `photos/[id]` renders a full page on a hard one; closing the modal is `router.back()`, not local state. Verified in a real browser (7/7 in `e2e/photos.spec.ts`), which is where the missing Tailwind build was found (PR #22)
- [x] Route handlers as a typed edge API with runtime selection (`edge` vs `nodejs`) per route — **the typed API is delivered; the per-route runtime selection is not possible.** Cache Components rejects the `runtime` segment config outright, for `"nodejs"` as well as `"edge"`, so no route handler can run on the edge while PPR is on. Delivered instead: `src/lib/api/` (handlers return data, not a `Response`), an `API_ROUTES` declaration carrying each route's runtime _and_ whether its module graph is portable, and `scripts/assert-api-runtimes.ts` checking both against the build output. Two invisible defects in the wrapper came out of the build: it swallowed React's prerender interrupt, and read `searchParams` unconditionally (PR #27)
- [x] `unstable_cache` / `revalidateTag` tag-based invalidation strategy across mutations — the strategy is delivered and it closed a live staleness bug: all three post mutations ended in `revalidatePath("/posts")`, a route whose reads are uncached, so the public blog was never invalidated by anything. Tags now live in `src/lib/cache/tags.ts`, the mutation→tags policy in `src/lib/cache/invalidation.ts`, and `scripts/assert-cache-invalidation.ts` fails CI if a writing action skips it. `unstable_cache` was tried rather than assumed and is **not** forbidden under Cache Components — it built and prerendered static with a 1m window — so `"use cache"` is preferred on its merits, not by necessity (PR #28)
- [x] Draft mode for CMS preview with signed preview tokens — the token is HMAC-SHA256 over a payload carrying the **path**, an expiry and a nonce, which is the part Next's own guide leaves out: there the redirect target comes from the query string, making every preview link an open redirect for the origin and making all links interchangeable. `/blog` keeps its static prerender because `draftMode().isEnabled` is the one request-scoped read Next does not track as dynamic — the tracking sits on `enable()`/`disable()`, verified against a production build rather than assumed. The e2e test earned its place immediately: it caught an unpublished post being served to an anonymous request with a 200, because relaxing the page's `!post.published` guard was only safe once the _read_ applied the filter (`getPublishedPostById`). `exp` bounds the link, not the session it opens — scoping a live session per path needs `cookies()`, which is exactly the tracked read that would end the prerender (PR #29)
- [x] Streaming with granular Suspense boundaries and per-segment `loading.tsx` skeletons — every route under `(dashboard)/` satisfied the route-shape gate while shipping a document made of the sidebar and grey boxes, because each page opened with `await getRequiredSession()` and everything below it was therefore absent from the built HTML. The boundary now sits around each read: `/dashboard` streams the greeting and the four `<dd>` values behind a fallback that renders the real `<dt>` labels, `/posts` streams the count line and list as one boundary (one per _read_, not per element), `/images` and `/upload` are synchronous and prerender whole. Page and `loading.tsx` share one `*Frame` and one `*Fallback`, which caught `/posts`'s skeleton drawing a three-column card grid for a list that has always been vertical. The three routes that were "protected" by that page-level read joined `PROTECTED_PREFIXES`, since gating on a cookie in a page body is authorisation by rendering and costs the route its prerender; the checks next to data stayed. Documents before → after: 10,576 → 12,570, 7,808 → 6,178, 6,537 → 6,513, 6,297 → 18,427, 5,795 → 7,846 bytes — and all five now contain their own `<h1>`, which none did. `scripts/assert-streaming-boundaries.ts` gates it, verified against the failure it names: restoring the read to `images/page.tsx` leaves `next build` and `assert-route-shape` green and fails it with three missing needles (PR #30)
- [x] `generateStaticParams` + on-demand ISR revalidation webhook — `generateStaticParams` was already prerendering one page per published post, so the work was the half with no path at all: a change made _outside_ this application, which is what a CMS, a migration or a restored backup is. `POST /api/revalidate` is authenticated by an HMAC signature rather than a session, because the caller has no browser. Three things about it are load-bearing and each is the one that would otherwise be got wrong. The signature covers the **raw bytes**, which is why this is the only handler not built on `defineRoute` — a wrapper that parses the body leaves nothing to verify against, and `JSON.stringify(parsed)` is not what was signed: key order, escaping and whitespace all survive the sender's serialiser and none survive a round trip through ours, so a re-serialising verifier both rejects valid requests and verifies something other than what arrived. The **timestamp is inside the signed material**, so it cannot be rewritten to refresh a captured delivery; the five-minute window is symmetric and bounds replay but does _not_ make delivery exactly-once, which needs a store of spent signatures shared by every instance — recorded as a limitation rather than faked with a module-scope `Map` that would work on one server and silently do nothing behind a balancer. And `revalidateTag(tag, { expire: 0 })` rather than the `updateTag` every Server Action here uses: `updateTag` throws E872 outside a Server Action (Next tests `workStore.page.endsWith('/route')`, so it fires for _every_ route handler) and `refresh()` throws E870, so a webhook wired to `invalidate()` typechecks, passes its entire unit suite, and answers 500 to every real delivery — mocking `next/cache` is exactly what hides it. Checked against that failure rather than assumed: swapping the call and rebuilding turns the end-to-end test into `Expected: 200, Received: 500` with the unit suite still green, which is why `revalidateFromWebhook()` is a second entry point onto the same `tagsFor` policy instead of a flag. The wire vocabulary names transitions (`post.published`, `post.updated`, `post.unpublished`, `post.deleted`, `blog.refresh`, `ping`) rather than reusing `CacheMutation`, whose `wasPublished`/`isPublished` pair is an observation only the mutating code can make — asking a remote system for it would make invalidation policy a function of its opinion, an attacker's included. `ping` exists so a CMS's "send test event" button is not a production cache purge, and an unknown event is a 422 listing the six rather than a silent 200 that would let a sender misconfigured to `post.publish` report healthy deliveries forever. Two defects came out of the work and are fixed: `cp .env.example .env`, the first step in `README.md`, produced a process that would not boot — a `.env` line with no value sets the variable to `""`, which is _present_, so `.optional()` never applied and `.min(32)` rejected it (reproduced against `pnpm db:seed` before and after; a short secret is still rejected, since "unset" and "too short to be a key" are different) — and the ISR callout on `/blog/[slug]` still advertised `dynamicParams = true`, an export Cache Components removed and one the route's own doc comment already said was gone. The HKDF derivation moved to `@/lib/crypto/hmac`, shared with the preview signer rather than copied: both fall back to `NEXTAUTH_SECRET`, so the domain separator is the only thing keeping a preview token from being a valid webhook signature, and that is now one implementation with a test asserting the property. 710 tests across 68 files, all 11 checks green (PR #31). Not done: `e2e/auth.spec.ts` and `e2e/form.spec.ts` fail locally with Auth.js `UntrustedHost` — verified identical on unmodified `main`, so pre-existing and untouched; E2E is still not wired into CI, the gap carried since Phase 0.

Partial Prerendering is enabled (`cacheComponents: true`) with the tradeoff
guide in [docs/partial-prerendering.md](./docs/partial-prerendering.md). Six
routes are fully static, six are a prerendered shell with streamed holes.

`experimental.ppr` no longer exists in Next 16 — it was merged into
`cacheComponents`, which is typed `boolean` and has **no incremental mode**, so
there is no per-route opt-in and all 14 routes had to comply at once.

Three items below are affected by the move, and the Phase 5 ISR items are
redefined by it: `revalidate`/`dynamicParams` are gone from both blog routes in
favour of `"use cache"` + `cacheLife`/`cacheTag` in `src/lib/cache/blog.ts`, and
`revalidatePath` is now `updateTag`.

Two defects were found and fixed on the way, both of which had been invisible:

- `src/app/layout.tsx` awaited `auth()`, which reads cookies and made **every**
  route dynamic. `/blog`'s `export const revalidate = 60` had never taken
  effect — the Phase 5 ISR items were written but not in force.
- `(dashboard)/layout.tsx` awaited the session in its body, so the "static
  shell" for `/posts` was 2,620 bytes containing a `<title>`. Its session read
  was also the only authorisation check on `/images` and `/upload`, which are
  absent from `PROTECTED_PREFIXES`; both now guard themselves.

`scripts/assert-route-shape.ts` asserts the route table and the shell contents
after every CI build, so neither defect can return quietly.

### The first of those three items, and what it cost

The route-handler item above is the first of the three, and it is the one the
move did not merely redefine but partly **forbade**. `export const runtime` does
not compile at all under `cacheComponents`:

```
Route segment config "runtime" is not compatible with
`nextConfig.cacheComponents`. Please remove it.
```

The check is on the export existing, not on its value — `"nodejs"` fails
identically to `"edge"`. This is Next's documented position: Cache Components
requires the Node.js runtime, `runtime = "edge"` is deprecated, and per-route
edge behaviour is directed at Proxy, which this repository already has in
`src/proxy.ts`.

So **"runtime selection per route" is unavailable for as long as PPR is on**,
and the two are mutually exclusive by construction. Nothing in this repository
can work around it; the only lever is `cacheComponents` itself, which would
un-do the PPR item above. What stands in its place is a written-down
declaration (`src/lib/api/runtimes.ts`) and a gate that checks it against build
output — including whether a route claiming portability still traces only
framework packages, which is the half of the decision the framework does _not_
force. `docs/route-handlers.md` carries the reproduction and the tradeoff guide.

The two remaining affected items are draft mode and the ISR revalidation
webhook; neither has been attempted yet.

### The invalidation item, and the bug under it

The tag-based invalidation item above turned out to be a bug report. PR #21
moved the blog onto `"use cache"` + `cacheTag` and moved `/blog`'s invalidation
onto `updateTag`, but the three **post mutations** were never part of that move:
each still ended in `revalidatePath("/posts")`, which names the dashboard, whose
reads are uncached and so have no entry to drop. Nothing invalidated the blog.
Publishing a post did not put it on `/blog` for up to 60s, and deleting a
published one left its page serving a deleted post for up to 300s.

`revalidatePost(id)` — written for exactly this, with two passing tests — was
imported by nobody, and as an export of a `"use server"` module was also a
network-reachable endpoint accepting an arbitrary post id, under a comment
asserting it was not callable from the browser.

What stands now is a taxonomy (`src/lib/cache/tags.ts`), a mutation→tags policy
(`src/lib/cache/invalidation.ts`, a plain module, which is what closes the
endpoint hole), and a gate. The policy's substance is the published-state edges:
draft mutations correctly invalidate nothing, and unpublishing invalidates as
much as publishing — `wasPublished || isPublished`, which a "is it published
now?" check gets backwards while looking right.

`unstable_cache` was **tried, not assumed**, and the expected answer was wrong:
it is not forbidden under Cache Components. An experiment route using it built
and prerendered as fully static with a 1-minute window. So `"use cache"` is
preferred on its merits — no manual key parts, three windows instead of one, and
not being `unstable_` — rather than by necessity, and tags are the same
namespace for both either way. `docs/cache-invalidation.md` carries the
reproduction, the policy table, and the `pathWasRevalidated` downgrade that
makes `updateTag` and `refresh()` mutually exclusive.

Not done: no E2E coverage of invalidation. Asserting it end to end needs a
running server plus control over cache timing, which is a larger piece of
harness than this item.

## Phase 9 — Server Actions & Data Integrity

- [x] Server Action hardening: origin checks, auth assertion, and Zod input parsing on every action — five factories in `src/lib/actions/`, a CI gate with an empty EXEMPT list, and two live defects the schemas exposed (PR #32)
- [x] `useOptimistic` + `useActionState` end-to-end on a real mutation with rollback — the editor at `/posts/[id]`, over a form save (`updatePostAction`, the first `defineAuthedFormAction` here) and the publish toggle. Rollback turns out to be free and the _success_ path to be the one with a prerequisite: React discards the optimistic patch when the transition ends and re-reads the server value, so a rejected save restores itself, while a successful one shows stale data for a frame unless the row has been refreshed by then — meaning a mutation that skips its cache invalidation produces a flicker that looks like an optimistic-UI bug and is a cache bug. Two traps are load-bearing and both are covered: an optimistic update applied after the first `await` of an async transition has left that transition's scope and never rolls back, and React resets an uncontrolled `<form action>` when the action resolves _including on failure_, so the inputs are controlled or a rejected draft is thrown away. `/posts` keeps its TanStack Query mutations deliberately — both styles ship, cross-linked, with `docs/optimistic-ui.md` on when to use which. Registering the route in the streaming gate exposed that the dashboard sidebar is absent from its prerendered shell where it is present on every static route, because `NavLinks` calls `usePathname` and a dynamic segment's fallback shell cannot know the path (PR #33)
- [x] Idempotency keys for Server Actions to survive double-submit and retry — an optional fourth leg on the two authenticated factories, declared as `idempotency: { key, output }` and wired to `createPostAction`. The whole thing turns on the claim being a single `INSERT` against a unique index on `(scope, action, key)`: "does a row exist? no — insert one" has a window between its two statements, and that window _is_ the double-submit. Three details are load-bearing and none of them is obvious. A `claimToken` column makes the 60s lease safe — an attempt that stalls past its lease is taken over and then wakes up, and without the token it would write its result over the live claim or delete the row out from under it. Failures release the key so a retry can execute, which does **not** make a handler atomic: a handler that writes and then throws still duplicates, and that gap belongs to the outbox item below. And replay needs an output schema, because a stored result comes back out of a `Json` column with its `Date`s as strings — the breakage lands on the _second_ submission only. Zod also strips what the schema omits, so it must be exact; the first run of the new test caught precisely that, against a fixture carrying a field the real `select` does not return. The client half is where this normally fails, so the dialog holds its key in a ref keyed by payload — a key minted inside the submit handler compiles, reads correctly and deduplicates nothing. Verified beyond the suite against a live Postgres 16: five truly concurrent attempts on one key ran the handler once, with lease takeover and stale-token rejection confirmed. Not done: nothing sweeps expired rows (there is no scheduler here; `docs/idempotency.md` carries the query and `@@index([expiresAt])` exists for it), and there is no E2E double-submit test. 887 unit tests green (PR #34)
- [x] Optimistic concurrency with a `version` column and a conflict-resolution UI — the editor posts a whole document minutes after reading it, so every write to the row in between was invisible to it and the second save silently erased the first. `Post.version` goes in the `WHERE` of the save, which is one `UPDATE … WHERE id = $5 AND "authorId" = $6 AND "version" = $7 RETURNING …` with the increment evaluated by Postgres — the check is inside the write rather than a read before it, because "look, then act" leaves exactly the window it claims to close, and the increment is too, because `version + 1` in JavaScript is a number two writers can both arrive at. `updateManyAndReturn` rather than `update`: the latter's `P2025` is exception-shaped control flow for an expected outcome and a `catch` that still cannot say whether the version moved or the row was deleted. A conflict is a **successful** `ActionResult` (`SavePostOutcome`), because the failure half carries a sentence and a conflict the UI can act on has to carry a row. Detection alone would only be a save button that fails, so the panel is a three-way merge: comparing what the editor loaded, what is in the browser and what is now in the database is what keeps the questions few — they retitled the post while I rewrote the body, which pairwise reads as two conflicts and makes the author pick whose work to destroy, and against the common ancestor is not a conflict at all. Resolving deliberately does **not** save; it loads the merge into the editor and rebases the draft on the version it was reconciled against, without which the next save carries the version first loaded, is rejected by the same check, and the panel is a loop rather than a way out. The empty result is not self-explaining, so the conflict path re-reads and separates three cases — somebody else wrote it, this same save already wrote it (the ordinary double-submit, stale _because of its own success_, which would otherwise end in a panel offering a choice between two identical documents), or the row is gone. `published` stays outside the version: `togglePublishAction` writes that column and nothing else, so the two cannot lose each other's work, and bumping it on a publish would reject an open editor's save over a change touching none of its fields. Verified beyond the mocks against a live Postgres 16: five truly concurrent saves on one version produced exactly one winner and four empty results, the losers' re-read returned the winner's row, a stale token whose text already matched was reported saved, and the wrong owner matched nothing even holding the right version. `e2e/conflict.spec.ts` drives two live browser tabs through the whole flow and was checked against the failure it names — with the `version` line removed from the `WHERE`, both cases fail. 917 unit tests, up from 887; all 11 checks green (PR #35). Not done: E2E is still not wired into CI, so those two browser cases did not gate the merge; two rapid publish toggles still race with each other (a different bug needing a write that names the transition); and a plain save with no conflict near it stalls ~4s on roughly a third of attempts under `next start` over a `standalone` build, measured with one tab and no second writer, so pre-existing and untouched.
- [x] Rate limiting Server Actions and route handlers at the edge — "at the edge" turns out not to exist in Next 16, and this was read in the framework rather than assumed: `get-page-static-info.js` rejects a runtime segment config in the proxy file outright ("Proxy always runs on Node.js runtime"), the build's own `functions-config-manifest.json` records `/_middleware` as `nodejs`, and route handlers cannot declare one either for the separate reason `src/lib/api/runtimes.ts` documents. So nothing here runs on the edge runtime, and what the item is actually about is delivered instead — the limit is applied in `src/proxy.ts`, before routing, before the session read, before any connection is opened — with the module graph kept to the Fetch API and `next/server` so it moves the day a choice exists. Like the hardening and invalidation items, this was partly a bug report: `config.matcher` excluded `api/auth` so OAuth callbacks would not be gated by the session check, which is the right intent through the wrong mechanism — excluding a path from the matcher excludes it from the _whole_ proxy, and `POST /api/auth/callback/credentials` is the password check, reachable directly by anyone who fetches `/api/auth/csrf` first. Every guess ran a full argon2 verification and nothing counted it. The exclusion now lives in `isAuthEndpoint`, where it skips the session read alone, and that callback shares one bucket with the `/login` and `/register` Server Actions so alternating between the two doors does not buy twice the attempts. Three details are load-bearing and none is the obvious spelling. `X-Forwarded-For` is read from the **right**, counting back `RATE_LIMIT_TRUSTED_PROXIES` hops, because everything left of the entry our own proxy wrote is client-supplied — `split(",")[0]`, which is what most examples do, hands an attacker a fresh bucket per request; a chain shorter than configured falls back to the rightmost entry, not the leftmost, so a misconfiguration over-counts rather than silently restoring the bypass. IPv6 is keyed by /64, because one subscriber is routinely given a whole /64 and a /128 key lets one machine mint 18 quintillion buckets — with IPv4-mapped addresses reported as IPv4, or a dual-stack listener would collapse the entire IPv4 internet into `::ffff:0:0/64`. And a Server Action is the `Next-Action` header **or** a POST to a non-`/api` path, because Next omits that header on the progressive-enhancement form post and `curl` omits it too, so a header-only check is bypassed by leaving it out; the second test is structural rather than heuristic, since App Router has no other way to POST to a page path. Page navigations are deliberately unlimited (Next prefetches every `<Link>` that scrolls into view, so a budget low enough to defend would refuse the framework's own traffic) and `/api/health` is exempt by declaration (a probe answered with 429 is an instance the orchestrator restarts). Sliding window counter rather than fixed, which allows twice the limit across a boundary. `scripts/assert-rate-limit-coverage.ts` reads the _compiled_ matcher out of the build and fails on an endpoint the limiter cannot see or that matches no rule — run against main's own build output it reported exactly the `api/auth` hole. Driving it against a live `next start` over Postgres 16 found a real defect in the first version: `Retry-After` was the end of the current window, which is the obvious answer and is wrong for a sliding window, because a caller who obeys it arrives one millisecond into the next window where the previous count still overlaps almost entirely and is refused again having done as it was told. A decision now carries two instants — `retryAt`, the same equation solved a second time against the window after the turnover (66 seconds at ten a minute, not 60), and `resetAt`, when the whole budget is back — and each header gets the right one. 1024 unit tests, up from 917; all 10 checks green (PR #36). Not done: a refused Server Action still surfaces through `error.tsx` rather than its own form, because the proxy cannot synthesise a Flight payload — that needs a second tier inside the action factory, which is also where a per-user budget belongs, since keying on the network means an office behind one NAT gateway shares a bucket. The in-memory store is per process, so N instances enforce N times every limit; the interface is one method and `docs/rate-limiting.md` carries what a shared implementation must do. No E2E coverage.
- [x] Transactional writes with Prisma interactive transactions + an outbox row — every post mutation was a write followed by an effect, which has no failure mode in development and two in production: the process dies between them and the invalidation is lost with nothing recording that it was owed, or the effect throws and — because `runIdempotent` releases the key when a handler throws — releases a key over work that had already committed, so the retry writes a second post. `@/lib/actions/idempotency` named that hole and pointed here. The fix is structural: `writeWithOutbox` runs the writes in an interactive transaction and writes what the handler `emit`s as `outbox_events` rows _in that same transaction_, so an event exists if and only if the write committed; the dispatch happens after the commit and can no longer fail the action, leaving a `PENDING` row for the relay instead. Three things are load-bearing and none is the obvious spelling. The inline dispatch is not an optimisation — `updateTag` is the only one of Next's two invalidation calls that gives read-your-own-writes, so leaving it all to the relay would serve the person who just clicked Publish the copy they were trying to clear; the relay uses `revalidateTag` because the other two throw outside a Server Action, which was **observed rather than assumed** (driving `writeWithOutbox` outside a request context produced exactly E872), and that is why the dispatch context is a parameter. The relay is an endpoint, not a worker, because `revalidateTag` is a call into the _running server's_ cache handler — a cron container importing it would claim rows, dispatch them, mark them processed and drop nothing; `POST /api/outbox` shares `/api/revalidate`'s HMAC and secret, since everything it can do is drop tags for events the application itself recorded. And "claimed" is deliberately not a status: a claim is a token plus a lease on a `PENDING` row, so a `CLAIMED` row with an expired lease _is_ `PENDING` and two representations of one fact is a query that forgets one. The claim is two statements carrying the same availability predicate — it can under-claim, never double-claim; retries are full jitter held in `availableAt` rather than in the worker, so they survive a restart; an unparseable payload is dead-lettered on its _first_ attempt, because no amount of retrying turns unreadable bytes into readable ones. Two gates, for two properties nothing at runtime checks: `assert-transactional-writes.ts` fails on the singleton used inside the callback (it compiles, type checks — both are clients with the same methods — and passes every unit test, because the tests mock `@/lib/prisma` and the mock hands back the same object, while in production it runs on a second connection and survives the rollback meant to undo it), on a renamed or absent `tx` binding, and on an outbox row written outside `@/lib/outbox`; `assert-cache-invalidation.ts` R1 now recognises `tx` as a client and `emit()` as a report, without which every transactional mutation would pass it _vacuously_. Verified beyond the suite against a live Postgres 16 — an aborted transaction left neither a post nor an event, the same callback written with the singleton left the post behind after the rollback (so the gate guards a defect that reproduces), four concurrent relays over ten rows dispatched each exactly once, a failing dispatch backed off and completed on the next pass. 1101 unit tests, up from 1024; all checks green (PR #37). Not done: no E2E coverage, so the inline dispatch inside a real Server Action is asserted only against a mocked `next/cache`; nothing pokes `/api/outbox` on a schedule, since this application has no scheduler — without one the outbox still works for every event whose inline dispatch succeeds and accumulates the rest as `PENDING`, which is the failure being visible rather than silent; two rapid publish toggles still race with each other, since the transaction fixes which before/after pair the invalidation sees and not the lost update itself; and there is no dead-letter UI.
- [x] N+1 elimination in server components with batched Prisma queries — the textbook one was never possible here: every list read already pulls its relation through `select`, and rule N3 of the new gate is what keeps that true. What this application had is the App Router's version of the same arithmetic. Server components ask for what they render and Suspense boundaries render independently, so N components each read the same thing and none can see that the others already did — measured against a live server, one `/dashboard` request ran **five statements against `posts` for one user** (`@stats` counting posts and published posts, `@notifications` counting drafts and reading the last edited row, `@activity` reading the five newest) and decoded the same session cookie **seven** times. Every one of those queries was correct, indexed, and the smallest thing its component needed; the duplication was a property of the render rather than of any line in it, which is why it survived eleven green checks. Now three statements and one decode. Three things about `requestMemo` (React's `cache()`) are load-bearing and none is the obvious spelling: React keys the memo on argument **identity**, so a read taking `{ userId }` builds a new object per call site and memoises nothing — memoised in the source and not in production, which is what N4 fails; outside a React render it does not memoise **at all**, which is why wrapping the data layer changed nothing about the seed script or the suite and why _no test here can assert the deduplication_ (the numbers came from Postgres's statement log instead); and a memoised read is a read, so a `write → read` inside one request replays the state from before the write — `updatePostAction`'s conflict re-read, which decides whether an author sees a conflict panel, now goes through `.uncached` with the reason written down, safe before only because nothing else in that request happened to read the row first. The batch loader is not redundant with Prisma's own dataloader, which was **measured rather than assumed** on 7.9.1 over the pg adapter: it batches `findUnique` in one tick with an identical selection set and nothing else — not awaits in separate ticks, not two components selecting different columns, and never `findFirst`, which is what half the by-id reads here must be to carry their ownership or `published` predicate. So it fires exactly when the calls are already inside one `Promise.all`, which was never the N+1. Live, four `loadPost` calls across two parallel-route slots (three distinct ids, one wanted by both) left as two statements rather than four — the shared id being fetched once also being the proof both slots got the same instance. Instances are built only in `loaders.ts`, each behind `cache(factory)`, because a loader is a cache of rows with no expiry: right for a request, a cross-user data leak for a process (N7). `scripts/assert-no-n-plus-one.ts` has seven rules and, run against main's own sources, reports fifteen findings — the five component queries removed and the ten unmemoised reads — so the gate reproduces the defect it guards. Rendered tiles checked against the database on both branches of the new `GROUP BY` (2/2/0, then 3/2/1 with a draft). 1156 unit tests, up from 1101; all 11 checks green (PR #38). Not done: no E2E coverage, since the property is invisible to Playwright for the same reason it is invisible to Vitest; route handlers are unmeasured; `"use cache"` entries are out of scope, because deduplicating within a request and caching across them do not compose into anything either promises; the same arithmetic across a network boundary (a client component fetching per row) is unreachable by any rule here; and `PostList` in `(dashboard)/posts/_components/` is dead code that reads twice, left alone rather than widened into this change.

The hardening item was, like the invalidation one above, partly a bug report.
The three legs were remembered by hand in six actions and forgotten in two, and
that is invisible by construction: an action that checks the session and skips
the schema looks entirely normal. `getPresignedUploadUrlAction` interpolated an
unvalidated `filename` into an S3 key via `filename.split(".").pop()`, so
`"a.png/../../other-user/evil"` produced an "extension" containing slashes and
`..` and the object left `uploads/<user id>/` — the only access control in that
template. `deletePostAction` handed its argument to Prisma untouched.

What stands now is five factories in `src/lib/actions/`, applying origin →
session → schema in that fixed order, and `scripts/assert-action-hardening.ts`,
whose EXEMPT list is empty. Two rules rather than one: A1 requires a factory,
A2 requires that factory to have been _imported_ from the hardening modules,
because otherwise a local function named `defineAction` makes A1 green and
meaningless.

Next's own origin check was **read, not assumed**, and it is real — this does
not replace it. It closes one gap the framework documents in a comment: a
request with no `Origin` header is allowed through with a `warn()`. Absent means
refused here; every other rule matches Next's precedence exactly. So
`serverActions.allowedOrigins` stays unset in `next.config.ts` and
`ALLOWED_ACTION_ORIGINS` is the single allowlist.

The upload key is now built from the _content type_ — which is allowlisted and
signed into the presigned URL — rather than from a sanitised filename, so no
caller-supplied string reaches the key at all. Sanitising the filename would
have been the smaller change and a weaker property.

One rejected design is worth recording, because it passed every test but one:
resolving the session into a variable the handler closes over. The factory runs
once at module scope, so that variable is shared, and the `await` between
writing and reading it is one microtask wide — two concurrent callers swap
users. `define-authed-action.test.ts` has the regression test, verified against
the rejected implementation.

Not done, both their own items below: rate limiting and idempotency. No E2E
coverage of the origin check either — forging an action POST needs a real
encrypted action id against a running server. `docs/server-actions.md` carries
the factory table, the Next comparison, and these gaps.

## Phase 10 — Performance

- [x] Core Web Vitals instrumentation via `useReportWebVitals` shipped to an analytics sink — `<WebVitalsReporter>` in the root layout buffers what the hook reports and beacons one batch per page view to `POST /api/vitals`, which rates each metric server-side and hands it to a sink (`log` by default, needing no configuration; `http` behind `VITALS_COLLECTOR_URL`). Three things were not obvious: the queue dedupes by metric id because CLS and INP are _revised_ rather than re-measured, the flush is on `visibilitychange`/`pagehide` and never `unload` — whose mere registration costs the page its bfcache entry, slowing the visitor's next navigation in the metric this measures — and the path comes from `location`, not `usePathname`, because that is a per-request read and the build rejected it outright (`Uncached data was accessed outside of <Suspense>`) for putting a dynamic hole in all fourteen routes. Also found: `useReportWebVitals` re-subscribes without unsubscribing, so an inline closure registers six fresh `web-vitals` listeners per render. `scripts/assert-vitals-wiring.ts` gates the wiring; 104 new tests (PR #39)
- [x] Bundle budget gate in CI + per-route JS payload report — Next 16 removed
      the number: under Turbopack the route table prints revalidation windows
      and no sizes at all, so nothing was reporting payload size and the
      feedback loop for "this page got 80 kB heavier" was a user on a slow
      connection. `scripts/assert-bundle-budget.ts` reads the documents the
      build wrote, measures the scripts each tells a browser to fetch, and fails
      on a route over its ceiling. `noModule` scripts are excluded — Next's
      legacy polyfill bundle is 39.5 kB gzipped and modern browsers skip it, so
      counting it would add the same number to all 17 routes; the gate fails
      separately if it ever loses the attribute. Budgets are two numbers, not
      one: the shared baseline (React, React DOM, the router — 147.4 kB) moves
      on a framework upgrade, the per-route ceilings when a route's own code
      does. `ROUTE_BUDGETS` is checked in both directions, so neither a route
      that stopped prerendering nor a new one shipping unmeasured gets past it.
      Found on the way: the providers chunk is 80 kB gzipped (TanStack Query +
      Zod) and reaches every route but `/_global-error`, which is the one route
      that replaces the root layout. Verified against the failure it names —
      one `import { faker }` in the theme toggle put 15 of 17 routes 141–151 kB
      over budget — and the CI run on Node 24 reproduced the local Node 22
      numbers byte for byte. The table is written to the job summary panel and
      `.next/analyze/bundle-budget.json`; 50 new tests (PR #40)
- [x] `next/font` self-hosting with subsetting and zero layout shift — Inter and
      JetBrains Mono are downloaded at build time and served from this origin,
      replacing a `system-ui, sans-serif` body stack and a default
      `ui-monospace` that rendered a different document on every operating
      system. Self-hosting was the cheap half. The half a visitor perceives is
      the metric-matched fallback, and two `next/font` options do not do what
      they read as — both found by building the application twice and diffing
      the emitted stylesheet, not from the documentation. `fallback: [...]`
      does not add fallbacks, it **removes** the adjusted `@font-face`:
      declared with it and `adjustFontFallback` at its default of `true`, the
      build emitted no adjusted face at all and resolved the family to
      `"Inter", system-ui, arial, sans-serif` — the option that reads as extra
      safety is the switch that turns the safety off, and nothing warns.
      `adjustFontFallback: false`, meanwhile, does nothing: it is implemented in
      the webpack loader, and Next 16 builds with Turbopack. So neither option
      reports what the build did and only the emitted CSS does. The monospace
      face also overrides Next's donor, which is Arial for anything non-serif —
      a proportional font stretched 134.59% to match JetBrains Mono's _average_
      advance, right in total and wrong at every point inside the line, which
      moves the wrap point of the paragraphs that carry inline `font-mono`
      spans. Courier New is already the same 0.6 em (99.98%). The four override
      percentages are recomputed from `next/dist/server/capsize-font-metrics.json`
      on every build rather than trusted. `scripts/assert-font-loading.ts` gates
      all of it and was verified against the failure it names; 48 new tests. Not
      done: no head `<link rel="preload" as="font">` — Next emits the preload as
      an RSC resource hint that reaches 15 of 26 documents, so the gate asserts
      the weaker property that is true and docs/fonts.md records the gap
      (PR #41)
- [x] Third-party script strategy audit with `next/script` and a facade pattern
      — the one class of page weight every other gate here is blind to by
      construction: a vendor's script is in no chunk, in no route manifest and
      adds nothing to any route's first-load JavaScript, so the bundle budget
      cannot see it, and what it loads is decided after the build by someone
      outside this repository. So the control is a declaration, not a
      measurement. `src/lib/third-party/catalogue.ts` is the inventory — every
      origin a browser is asked to contact that this application does not
      serve, with how it loads, whether it is preconnected, the one module
      allowed to mount it and why it is worth the cost — and
      `scripts/assert-third-party-scripts.ts` keeps the inventory and the source
      from drifting apart across 8 rules: no hand-written `<script>` (JSON-LD
      exempt, `dangerouslySetInnerHTML` included), an explicit `strategy` on
      every `<Script>` because `next/script`'s silent `afterInteractive`
      default means the load order is otherwise decided by an omission,
      `beforeInteractive` only in the root layout where Next honours it, every
      absolute subresource host declared, `images.remotePatterns` and the
      catalogue agreeing both ways, every mount importing its entry's id
      constant, `next/script` imported only by declared mounts, and no facade
      or wildcard host preconnected. Every rule checked against the failure it
      names in the real tree, not only against fixtures. `VideoFacade` is the
      worked example: a poster frame and a `<button>` that answers Enter and
      Space, `autoplay=1` on the activated URL so the press that opened it is
      the gesture the autoplay policy wants, the connection warmed on hover and
      focus via React 19's `preconnect` rather than on every page view, and an
      `allow` list of the five capabilities a player needs instead of the
      vendor snippet's seven — `allow` is a Permissions Policy delegation, so
      `clipboard-write` and `web-share` in a copy-pasted embed are granted for
      the lifetime of the frame for nothing. The runtime half is not something
      a static gate can know, so `e2e/third-party.spec.ts` watches the network:
      an article settles with zero requests to the embed origin, and the player
      is requested on the press and only on the press — verified against the
      failure it names by flipping the facade's initial state to activated,
      which reports four requests on page load. Analytics is inert unless
      `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is set, confirmed in a browser both ways.
      `/blog/[slug]`'s budget goes 262 → 277 kB (measured 250.9 → 265.4 kB;
      the 14.5 kB is `next/image` plus `BlurImage`, which the route did not
      previously pull in) — raised deliberately against an embed that is
      ~1.2 MB on render. Also found and worked around a pre-existing
      test-isolation hazard: `revalidate-webhook.spec.ts` leaves `/blog`
      advertising a post it deleted, whose page answers 200 with the not-found
      boundary. 80 new tests; 13 CI gates, up from 12 (PR #42)
- [x] Edge middleware geo/AB routing with cookie-stable bucketing — `/pricing` is
      bucketed in the proxy: the canonical path is a real page rendering the
      control arm, and only the _other_ arms are rewritten to
      `/pricing/v/[variant]`, so the feature degrades into "everybody sees the
      layout we already had" rather than into a 404 when the proxy does not run.
      A rewrite, not a redirect, so the arm never reaches the address bar, a
      shared link or a search index; both arms prerender as static documents and
      neither ships a byte of JavaScript to choose between them. "Cookie-stable"
      is the resolved arm being _persisted_, not the hash being deterministic:
      the hash is stable with respect to the visitor and not the experiment, so
      a weight change from 50/50 to 70/30 moves every boundary and silently
      reassigns a fifth of the people already in the treatment — nothing fails,
      the dashboard just fills in with a wrong number. Precedence is override →
      cookie → targeting → hash; an override is never persisted and never
      counted, and a targeting fallback is neither, so a trip abroad does not
      pin anyone to the control for a year. The proxy strips its own headers
      from every inbound request as a loop over the constant, because Next
      merges proxy-set and client-sent headers with nothing marking which is
      which. Three framework facts found by trying rather than by reading:
      `dynamicParams = false` is rejected by `cacheComponents` (the same family
      as the `runtime` export), `notFound()` cannot set the status under a
      prerendered shell so an unknown arm answers 200 with the boundary (as
      `/photos/[id]` already did), and `Vary: Cookie` is discarded — Next
      overwrites `Vary` on every App Router response, from the proxy and from
      `next.config.ts` alike, while other headers set in the same place arrive
      intact, so the canonical path declares a `private` cache policy with a
      zero max-age instead. Every failure mode here is a working
      application, so `scripts/assert-experiment-wiring.ts` is a 9-rule gate
      over the registry, the route files, the proxy calls, the header
      stripping, the arm lists, the variant page, request-scoped reads in the
      subtree, the other gates' tables and the cache policy — each rule checked
      against the failure it names in the real tree, which caught a bug in the
      gate itself (the `robots` rule was a regex over file text and passed on
      `index: true`, satisfied by the doc comment quoting it; it reads the AST
      now). 263 new tests, 1700 total; 16 e2e cases passing locally against the
      production build; 14 CI gates, up from 13 (PR #43)
- [x] React Compiler enabled with a memo-removal audit — `reactCompiler: true`;
      of the four manual memos (all `useCallback`, no `useMemo`, no `memo()`)
      three were removed and one kept, the Web Vitals reporter's, where the
      stability is a correctness requirement React guarantees and the compiler
      only offers. Deleting the other three is safe only while the compiler is
      actually compiling what they came out of, and it stops silently:
      `panicThreshold` defaults to `"none"`, so an unsupported construct is
      skipped with no error, no warning and no observable difference in the
      build — leaving a component with neither the compiler's memoization nor
      the memo that was deleted. `ImageUpload` was exactly that, bailed out
      entirely by one `onUploadComplete?.(publicUrl)` inside a `try` block, and
      only the compiler could say so; the XHR body moved to a module-scope
      helper, which has nowhere to propagate a bail-out to.
      `scripts/assert-react-compiler.ts` is a 6-rule gate that drives the real
      `babel-plugin-react-compiler` over every `"use client"` entry point and
      everything it imports, reads the config Next resolved out of
      `required-server-files.json` rather than trusting the source, and
      requires a `@memo-keep` reason on any surviving memo or `"use no memo"`.
      Each rule checked against the failure it names, which caught a bug in the
      gate itself (a `VariableDeclarationList` and the `VariableStatement`
      around it start at the same offset, so every comment was collected twice
      and a one-word reason cleared the length check on prose borrowed from the
      comment above). Measured cost, gzipped first load: +0.4 kB on
      `/_not-found` to +6.5 kB on `/posts/[id]`, every route inside budget.
      41 new tests, 1741 total; 15 CI gates, up from 14 (PR #44)

## Phase 11 — Security

- [x] CSP with per-request nonces via middleware, `strict-dynamic`, no `unsafe-inline` — shipped as nonce plus build-time digests, and two measurements decided why. A nonce only reaches markup Next renders _during_ the request: `/` came back with 18 script tags and 0 nonces on a production build while `/dashboard` nonced the 24 scripts of its streamed half and none of its prerendered shell's, and the same policy in `next dev` nonced all 36 — so the prerendered documents' inline scripts are authorised by `'sha256-…'` emitted from the build output by `scripts/emit-csp-hashes.ts`. `'strict-dynamic'` is deliberately absent: it makes a browser ignore `'self'`, which refuses the 451 parser-inserted `/_next/static/…` tags in those documents, a number the gate measures rather than asserts; having it means giving up prerendering. Second finding: a nonce present during an ISR revalidation is baked into the cache — `blog.html` was rewritten 7 minutes after its build carrying one request's nonce on all 24 tags, and two later requests with their own nonces were both answered with it — so a path with a revalidation window gets `script-src 'self' 'unsafe-inline'`, no nonce, no digests, every other directive still enforced, and which paths those are is derived from `initialRevalidateSeconds` rather than declared. Also fixed: an inbound `content-security-policy` header was forwarded to the render, letting a caller choose the nonce the document is stamped with; and Zod v4's `new Function("")` capability probe, which reported a `script-src` violation on every page load until `disableZodJitInBrowser()` turned it off in the browser. 141 new tests, 1882 total; 16 CI gates, up from 15; zero violations in Chromium across the public routes, a 404, the rewritten `/pricing` and the signed-in dashboard (PR #45)
- [x] Auth.js session hardening: rotation, reuse detection, and secure cookie flags — the item found a Phase 0 defect underneath it: **sessions did not work in a production build at all**. Auth.js derives `trustHost` from `AUTH_URL`, this repository uses the v4 name `NEXTAUTH_URL` everywhere (`.env.example`, the env schema, CI, the Dockerfile), and that name is not in the list it checks — so a production build anywhere but Vercel got `trustHost: false` and `assertConfig` refused every request into `@auth/core`. On unmodified `main` with `pnpm build && pnpm start`, `/api/auth/csrf` answered 500, so did `/api/auth/session`, and the credentials callback answered 500 without reaching the password check; nobody could sign in, and every guard correctly failed closed on the resulting `null`, while the build exited 0, 1,882 tests passed and all sixteen gates were green, because none of them start the server and sign in. The fix is a pair and only a pair — `@/lib/auth/deployment` copies the validated `NEXTAUTH_URL` into `AUTH_URL`, the only variable `createActionURL` reads, and `trustHost: true` follows — because trusting the host is dangerous exactly when the host decides something, including (through `url.protocol`) whether the cookie is marked `Secure`. That pin is also what makes the cookie flags a deployment fact rather than a per-request reading of `x-forwarded-proto`, and the session cookie moves to the `__Host-` prefix, which additionally forbids a `Domain` and so cannot be set by a sibling subdomain. On top of it: every session is a family (`sid`), its token (`tid`) rotates every 15 minutes of use, a token that is neither current nor the one just replaced revokes the whole family, sign-out revokes the row rather than only clearing the browser that asked, idle drops 30 days → 24 hours and a 7-day absolute deadline is added on the `sat` claim, checked before the registry so it holds when the database does not. Two decisions are load-bearing. Rotation happens **only** in `src/proxy.ts`, the one caller whose response carries the `Set-Cookie` — `next-auth`'s RSC path reads the session body and drops its headers — so rotating elsewhere would advance the registry to a token the browser never receives and read its next request as theft. And the claim is `tid`, not `jti`: `@auth/core`'s `encode` ends `.setJti(crypto.randomUUID())`, overwriting it after the callback returns, which the first draft learned the hard way — the first sign-in against a production build logged `session_started` → `token_reuse` → `session_revoked` in three lines with the entire unit suite green, because a test that mocks the encoder never encodes. Verified against a running production build with the constants shortened for a probe: rotation advances the row and issues a new cookie, the replaced token is served inside its grace window and revokes the family after it, the victim's own token dies with it, and sign-out and the absolute deadline each record their own reason. `scripts/assert-session-hardening.ts` gates six properties whose loss leaves a working application, each rule checked against the regression it names by breaking a copy of the tree. 1,981 tests across 133 files, up from 1,882 across 127; 17 gates, up from 16 (PR #46). Not done: Playwright is still not wired into CI, so the browser-level evidence is curl against `pnpm start`; there is no password-change action, so "revoke every session for this user" is written out in `docs/session-hardening.md` rather than shipped as a method with no caller.
- [x] Server-only secrets enforced by `server-only` imports and a lint rule — three layers, because each one is blind to what the next catches. `import "server-only"` on the seven modules holding key material or a connection to it is the mechanism: Next aliases the package to a module that throws when it is compiled into a client bundle, verified by probe rather than by reading the docs — a `"use client"` component importing the env module failed `next build` with the four-module chain printed under it. What the marker cannot see is the read with no import: `process.env.NEXTAUTH_SECRET` in a client component is `undefined` in a browser, so every check built on it passes and nothing anywhere fails. That is what the `server-only/no-secret-env-access` ESLint rule is for, and it found the live instance — `src/auth.ts` built its Google provider from `process.env["GOOGLE_CLIENT_SECRET"] ?? ""`, an OAuth client configured with an empty secret whenever the variable is absent, bypassing the schema that would have refused to boot. `scripts/assert-server-only.ts` is the third layer, five rules over the module graph, and R1 is the one that justifies it: deleting the marker from the env module fails nothing else here, because the unit suite has to alias the marker away and a build with no client component importing the module is green either way. `src/lib/env.ts` split into `env/server.ts` (marked) and `env/client.ts` (deliberately not) — one module validating both halves cannot be marked, since `NEXT_PUBLIC_*` is read in the browser, and left unmarked it puts the name of every secret one import away from a client component. Second defect found: the client-graph walk shared by the CSP and React Compiler gates followed `import type`, which TypeScript erases entirely, so `src/hooks/use-posts.ts` — a `"use client"` module whose only link to the data layer is a type — put `@/lib/prisma` three imports inside the client graph on a build that is entirely correct; fixed with `withoutTypeOnlyImports`, and both gates now agree with the bundler. Each non-Next runner opts out of the marker and not the boundary: Vitest aliases it to the package's own `empty.js`, Playwright maps it through `e2e/tsconfig.json`, and `pnpm db:seed` runs `tsx --conditions=react-server`. 2,028 tests across 136 files, up from 1,981 across 133; 19 CI gates, up from 18 (PR #47). Not done, and said so in `docs/server-only.md` rather than implied: a secret passed to a client component as props is a serialised secret in the RSC payload and satisfies every layer here, and log redaction is a separate item.
- [x] OWASP Top 10 checklist with a test per mitigation — `docs/owasp-top-10.md`, bound to the tree by `scripts/assert-owasp-checklist.ts` (the 20th gate), because a security checklist is the file most likely to be wrong and least likely to be noticed being wrong. Two rule families: C1-C6 check the document's own citations — all ten 2021 categories present and in order, every mitigation carrying a test, every module it names existing, every cited test _declared_ in a file Vitest collects (the title has to be the argument of an `it`/`test`/`describe` call, so a name surviving only in a comment fails), every gap naming an open item here, and no two rows resting on one assertion. T1-T4 check the four claims no unit test can make, because an absence across a repository is not something a unit test can assert: no raw SQL anywhere, no outbound `fetch` outside five enumerated call sites each recording why its target cannot be chosen by a caller, every `remotePatterns` entry https with a domain-anchored hostname (`/_next/image?url=` is the SSRF boundary), and a supply chain that cannot drift — frozen installs, an exactly pinned package manager, both Dependabot ecosystems, no action on a moving branch. Writing the rows found two things the tree did not have. **An open redirect, live**: `src/auth.config.ts` accepted any `callbackUrl` starting with `/`, fourteen files from `@/lib/preview/token`, whose comment says in as many words that `startsWith("/")` is not enough. Measured against a production build of `main`, signed in — `GET /login?callbackUrl=//evil.example/phish` answered `302 Location: http://evil.example/phish`, the `/\evil.example` spelling did the same, and `callbackUrl=//` answered **500** because `new URL("//", nextUrl)` throws inside the proxy. A phishing link that opens with this application's own hostname is the whole value of the technique. The existing test, "ignores an absolute callbackUrl to prevent open-redirect", passed throughout: an absolute URL is the one shape a leading-slash check does catch, and it was the only one covered. The predicate is now `@/lib/security/safe-redirect`, one copy, and `@/lib/preview/token` delegates to it. **No hardening headers at all**: every response carried a CSP and nothing else — no `nosniff` on the JSON routes, no HSTS, no referrer or permissions policy. `@/lib/security/headers` adds five on every return path in the proxy, the 429 and the gate's redirect included. `X-Frame-Options: DENY` earns its place rather than duplicating `frame-ancestors 'none'`: the CSP is deliberately unenforced in two supported states (`CSP_REPORT_ONLY=1`, and a production server with no hash manifest), and clickjacking protection would silently be gone in both. No `preload` — months to reverse, every subdomain, not a boilerplate's decision. Also filled two holes the audit exposed: `reportSessionEvent`, the function that writes the auth audit trail and the only part of session hardening a log pipeline sees, had no test because every case injects its own reporter; and `toParagraphs` had no test for the no-markdown-renderer decision its own header states. 2,092 tests across 139 files, up from 2,028 across 136; 20 CI gates, up from 19 (PR #48). Both code changes were probed against `pnpm build && pnpm start`, because both are about what leaves the process: the headers arrive on a document and on `/api/health`, HSTS is absent over plain HTTP and present behind `x-forwarded-proto: https`, and all three poisoned `callbackUrl` shapes now answer `302 -> /dashboard` while `/posts?tab=drafts` arrives intact. Not done, and written into the document rather than implied — each tracked by one of the five items this added to the end of this phase: scrypt's cost parameters are Node's defaults and unrecorded in the hash, so they cannot be raised without invalidating every existing one; there is no "sign out everywhere", so the registry's per-user revocation still has no caller; there is no log redaction and nothing alerts on `token_reuse` past `console.error`; the actions are tag-pinned, not digest-pinned; and nothing scans the pinned tree for known advisories — `pnpm audit` is deliberately not a per-PR gate, because an advisory against a transitive package would turn every unrelated PR red in a repository whose rule is never to merge red.
- [x] Multi-tenancy with row-level security and a tenant-scoped Prisma client — the isolation is Postgres's, not the queries'. This repository already had the careful version, and the item exists because that version has a limit: a `where` clause protects the queries written with it in mind, and the next `findMany` added to a dashboard passes review, passes its test and passes CI, because in every environment it will run in there is only one tenant's data to return. `prisma/rls.sql` puts forced row-level security on `posts`, `tenants` and `memberships`; `src/lib/tenancy/client.ts` gives three access worlds that are visible at the import — `tenantClient`, `unscopedPrisma`, `withPreviewRead` — and opens every scoped statement with `set_config(…, TRUE)`, transaction-local being the only form safe on a pooled connection. The active workspace arrives in a cookie and is checked against `memberships` every request, deliberately not as a JWT claim: the token is re-minted only on rotation, so a claim would go stale for fifteen minutes after a membership was revoked. A cookie naming a workspace the user is not in is refused rather than falling back to one they are.
      Three findings, none of them reasoned out. **The policies were installed and enforcing nothing**: row-level security is skipped for a superuser and for `BYPASSRLS` with no warning, notice or error, `.env.example` shipped a `postgres` URL and CI's container has one role — so the first apply passed everything and a deployment like it has exactly as much isolation as one with no policies. Hence the `app_rls` role, the `DATABASE_ADMIN_URL` split, and probe T1, which reports nothing else until it has established the connecting role cannot bypass what it measures. **A production build found a 500 the whole suite passed over**: the "which workspaces may I open" read precedes any scope and joins `tenants`, which no policy made visible yet — and a join against an invisible row is NULL, not an error, so every signed-in request died on `Cannot read properties of null (reading 'slug')` while 2,200 tests were green, because a mocked membership row comes with its tenant attached. **CI found the third**: the file is one multi-statement query and `tenants_member_read` called `app.current_user_id()` above its definition, which only a database that has never seen the file can fail on — every local re-apply passed. R6 now fails the build on any `app.*` function used above its definition. Also corrected a claim the first draft made and a real server disproved: `USING` without `WITH CHECK` does _not_ permit a cross-tenant row move, because Postgres defaults the omitted clause to `USING`. `assert-owasp-checklist` rule T1 became a two-way allowlist, since `set_config` has no builder spelling; both entries use bind parameters. 2,241 tests across 146 files, up from 2,092 across 139; 20 CI gates, up from 19 — the new one is six static rules and eleven live probes against a real Postgres with two tenants, each checked by sabotaging that database in the way it names (PR #58). Not done: draft mode is a whole-site preview, so a token minted in one workspace opens every workspace's drafts — pre-existing, made visible by having to write the rule down as `posts_preview_read`, and tracked by the item at the end of this phase. Provisioning still needs an administrative connection, and the blog's cache entries are not keyed by tenant; both are in `docs/multi-tenancy.md` rather than implied.
- [x] File-upload validation: content sniffing, size caps, and antivirus hook — the upload path had three checks on the content type and none of them looked at the file: `file.type` comes from the filename's extension, the schema checked that string, and the presigned URL signed it, which are one caller-asserted fact repeated three times. Because the signed type becomes the object's stored `Content-Type`, the allowlist was not deciding what got stored but what arbitrary bytes would later be _labelled_ as, so renaming `payload.html` to `payload.png` was the whole bypass. Three findings underneath it. **The size cap bound nothing**: `sizeBytes` was validated and then dropped, and with `content-type;host` signed over an `UNSIGNED-PAYLOAD` the URL authorised a PUT of any length — a declared one byte could write five gigabytes with every check passing; `content-length` is now signed and the readback re-measures what landed, which is the half this repository can actually prove. **The presign handed back `publicUrl`**, a public address for an object nothing had inspected, issued before the upload happened; uploads now land under a `quarantine` prefix and `finalizeUploadAction` is the only thing that returns a URL, after the length, the sniff and the scan agree, copying to the public prefix with the _sniffed_ type and deleting whatever it refuses. **`image/svg+xml` was accepted and cannot be sniffed**: a well-formed SVG carrying `<script>` is a well-formed SVG, there is no byte pattern separating a drawing from a document, and served with the type the PUT signed it is parsed as a document in the bucket's origin — a phishing page on a raw S3 URL, same-site behind the CDN alias most deployments put in front of a bucket, stored XSS on the application's own host; it is refused, and re-enabling it is deliberately not an environment variable. The sniff compares against the type S3 _stored_ rather than one the caller re-declares, because a caller supplying that type would pick both sides of the comparison. The antivirus hook is a seam and not an engine — no Node dependency ships credible malware detection — handed the object's bucket and key rather than its bytes, with the failure policy as a pure function of two values: a configured scanner that does not answer refuses the upload, an absent one accepts and records `"scanned": false` at `warn` on every single upload, since fail-closed always would make a fresh clone reject everything until someone deleted the check and fail-open always would let an outage silently become an absence of scanning. `scripts/assert-upload-validation.ts` is the 21st gate, seven rules each checked against the regression it names by breaking a copy of the tree; its sharpest is that `finalizeUploadAction` compares the key's user segment with the session's own id, without which a signed-in caller has this server read, promote and hand back a URL for another user's unverified object using its own credentials. Closes the A10 gap in `docs/owasp-top-10.md`, which had predicted the readback would become a new outbound call site — it became four, each argued for in `FETCH_CALL_SITES`. 2,411 tests across 152 files, up from 2,241 across 146; 21 gates, up from 20; probed over real HTTP against a local stand-in for S3, not the unit tests' stubbed `Response` objects, confirming all eight outcomes (PR #59). Not done, and in `docs/uploads.md` rather than implied: S3's own enforcement of the signed `content-length` is unverified for want of a bucket, which is why the measured cap is not the only defence; a polyglot declared as the format it leads with is stored as that format, and what stops it running is the served `Content-Type` plus `nosniff`; nothing re-scans after promotion; image dimensions are not bounded; and the bucket policy must keep the quarantine prefix private and expire it.
- [x] Password hashing that records its own cost parameters, with verify-then-rehash on sign-in — the hash now carries its parameters PHC-style (`$scrypt$ln=16,r=8,p=2$salt$key`) and `verifyPassword` derives at the parameters it reads out of the stored string rather than at the current policy, so an old hash keeps verifying at the cost it was made at while `needsRehash` reports it as behind. Sign-in is the only place that can act on that: the stored value is a one-way function of the password, and the password exists in this process for exactly one request in an account's life, so there is no migration that could do it instead. **A second thing pinned the old cost and is in none of the guides**: `crypto.scrypt` defaults `maxmem` to 32 MiB and refuses any parameter set needing more, so recording the parameters is necessary and not sufficient — on Node 22, `scrypt(pw, salt, 64, { N: 2**15, r: 8, p: 1 })` with no `maxmem` raises, and so does every larger N, which means the previous module could not have had its cost raised even with a format that recorded it. `maxmem` is now derived from the parameters using OpenSSL's own accounting, `128 · r · (N + p + 2)`, rather than the usual `128 · N · r` shorthand: the shorthand is that expression with the `+ 2` dropped, a rounding error at N=2^16 and larger than the whole allocation at N=2, and the tests — which hash at the cheapest parameters accepted — are what caught it. The parameters are OWASP's second equivalent row rather than its first: `ln=16,r=8,p=2` and `ln=17,r=8,p=1` cost the same (414 ms against 386 ms, measured) but peak memory is `128 · N · r` and halves with N, and that number is multiplied by concurrency because Node runs scrypt on the libuv thread pool. Three things beyond the format are load-bearing. The upgrade write is a compare-and-set naming the hash it verified against — two concurrent sign-ins racing is harmless, both derive a valid hash of the same password, but a password _change_ landing between the verification and the write would otherwise be silently reverted to a re-derivation of the password just replaced. The reported event carries the error's _name_, never its message, because drivers put a statement's bound parameters into what they throw and here those parameters are a fresh password hash. And a stored hash is an input whose parameters are an allocation size read inside an unauthenticated POST — a row reading `ln=30` asks for 137 GiB — so the working set is bounded at 256 MiB on the product rather than on `ln` alone, out-of-range is `false` rather than a throw, and the base64 fields are re-encoded and compared, because `Buffer.from(s, "base64")` skips characters outside the alphabet and without that `salt!!` decodes to `salt` and verifies. `scripts/assert-password-hashing.ts` is the 22nd gate, four static rules and four probes that derive real hashes, each checked against the regression it names by breaking a copy of the tree — because every part of this is invisible by absence: delete the upgrade call and sign-in still works, lower the policy and the whole suite stays green (since `needsRehash` measures against that same constant), drop the legacy branch and nothing fails until the first person with an old account signs in. The tenant-isolation gate caught a real defect while this was being written — the upgrade module reached for `@/lib/prisma` directly instead of declaring its access world; it writes through `unscopedPrisma` now, with the reason in `UNSCOPED_READERS`. Verified against `pnpm build && pnpm start` on a real Postgres and not only by unit tests, because what this changes is a row in a database: a hash planted by the previous implementation verbatim (161 chars, `hex.salt`) was replaced in place on one sign-in through `/api/auth/callback/credentials` with an 88-char `$scrypt$ln=16,r=8,p=2$…`, the second sign-in verified against the new hash and left the row byte-identical, a wrong password was refused and wrote nothing, the log carried one `password_rehash` line with no secret in it, and `/dashboard` answered 200 for the resulting session. 2,453 tests across 154 files, up from 2,411 across 152; 22 gates, up from 21 (PR #60). Not done, and in `docs/password-hashing.md` rather than implied: there is no password-change action, so an account that never signs in never upgrades — the next item owns that, and its action will be a fourth entry in `PASSWORD_WRITERS`; there is no minimum-strength or breach-corpus check on the password itself; and Playwright is still not wired into CI, so the browser-level evidence is curl against `pnpm start`.
- [x] Sign out everywhere: a password-change action that revokes every session for a user — the revocation is not a follow-up to the change, it is part of it: `src/lib/auth/password-change.ts` writes the new hash and ends every live family for that user in one transaction, because the window between two separate statements leaves an account with a password its owner did not choose and sessions they believe they closed, and no way to retry — the current password they would have to type is no longer current. That is also why the operation is not a method on `SessionRegistry` as `docs/session-hardening.md` sketched it: a method there brings its own client and cannot join the transaction writing `users`. Nothing is spared, this session included; sparing the caller's own family needs the `sid` out of their token, which this application deliberately keeps out of the session object handed to the client, so it would mean widening what a session exposes in order to narrow what a revocation covers. Two things went with the form rather than after it. `/settings/security` mounts it, with a page test asserting the mount — the `ThemeToggle` lesson, in a place where what is unreachable without the mount is the only way to revoke a session. And the action verifies a password, making it a third door into the credential check: without its own rate-limit rule the Server Action fallback would have allowed 120 guesses a minute against an account whose identity the caller already knows, so it shares `/login`'s ten-a-minute bucket. Rule R7 of `scripts/assert-session-hardening.ts` fails on a dropped revocation, a predicate keyed on the family instead of the user, either write moving off the transaction client, the transaction going away, and the action no longer calling the library — each checked against that edit, which caught a bug in the rule itself (`/\buserId\b/` is satisfied by `where: { id: userId }`, the exact regression it exists for). Measured in Chromium against a production build, because a test that mocks the store never writes a row: two sessions on one account, a change from one revoked both (`sessionsRevoked: 2`, both rows `REVOKED_BY_USER`, so the `events.signOut` that followed did not relabel them), the other bounced to /login with `/api/auth/session` answering null, the old password refused and the new one accepted; raw Server Action POSTs to the path took a 429 once the shared budget ran out while GETs of it were never counted. 2503 unit tests, up from 2453 (PR #61)
- [ ] Log redaction: a serialiser that refuses to print a secret-shaped value
- [ ] Pin every GitHub Action to a commit digest, with Dependabot digest updates
- [ ] A scheduled dependency-advisory audit that opens an issue rather than failing a pull request
- [ ] Scope draft-mode preview to the tenant that minted the token

_The five items above came out of the OWASP checklist item rather than being
invented for it: each is a gap `docs/owasp-top-10.md` records against a category,
and `scripts/assert-owasp-checklist.ts` rule C5 requires every such gap to name an
open item here — so ticking one of them fails the gate until that document is
revisited. They are deliberately last in this phase, so the order the scheduled
agent reads is unchanged. The first is now done, and C5 worked exactly as
described: A07's `**Gap**` bullet had to become two `**Mitigation**` bullets, with
their own tests, in the same pull request — otherwise ticking this line would have
failed the gate._

_The sixth came out of the multi-tenancy item the same way. Draft mode is a
whole-site preview, so a token minted inside one workspace opens every
workspace's unpublished posts; that is what draft mode has always done here,
and row-level security made it visible by requiring the rule to be written
down as `posts_preview_read` in `prisma/rls.sql` rather than being the default
behaviour of an unrestricted connection. See `docs/multi-tenancy.md`._

## Phase 12 — Accessibility & TDD

- [ ] WCAG 2.2 AA audit with axe in CI, zero-violation gate
- [ ] Focus management across App Router navigations with route announcements
- [ ] i18n with `next-intl`: locale routing, plurals, and an RTL pass
- [ ] TDD kata: one Server Action built red→green→refactor, one commit per step
- [ ] Playwright a11y + visual regression suite on the critical journey
