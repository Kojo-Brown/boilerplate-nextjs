# Partial Prerendering: static shell + streamed dynamic holes

Status: **enabled.** `cacheComponents: true` is set in `next.config.ts`, and
`scripts/assert-route-shape.ts` fails CI if the resulting route shape regresses.

This document is the tradeoff guide the Phase 8 spec item asks for. Everything
in it was measured against this repository on Next.js **16.2.12**, not taken
from the docs.

## What PPR does

One route, two rendering modes. The parts of a page that do not depend on the
request — the chrome, the headings, the empty states — are prerendered at build
time into a **static shell** a CDN can serve immediately. The parts that do
depend on the request — the signed-in user, a cart, anything reading `cookies()`
or `headers()` — are left as **holes**, wrapped in `<Suspense>`, and streamed in
after the shell has already reached the browser.

Without it the choice is per route and all-or-nothing: one `cookies()` call
anywhere in the tree makes the entire route dynamic. PPR makes the choice per
_component_.

## The route table, before and after

Before. Every route dynamic, no revalidation windows anywhere:

```
┌ ƒ /                     ┌ ƒ /dashboard
├ ƒ /blog                 ├ ƒ /posts
├ ● /blog/[slug]          ├ ƒ /admin
├ ƒ /login                ├ ƒ /images
└ ƒ /register             └ ƒ /upload      ƒ (Dynamic)  server-rendered on demand
```

After:

```
Route (app)                               Revalidate  Expire
┌ ○ /                                                        ○  (Static)
├ ○ /_not-found                                               prerendered as
├ ◐ /admin                                                    static content
├ ○ /blog                                        1m      1y
├ ◐ /blog/[slug]                                 5m      1y  ◐  (Partial
│ ├ /blog/seed-post-suspense-boundaries          5m      1y   Prerender)
│ ├ /blog/seed-post-cache-life                   5m      1y   static HTML with
│ └ /blog/seed-post-partial-prerendering         5m      1y   dynamic server-
├ ◐ /dashboard                                                streamed content
├ ○ /forbidden
├ ◐ /images                                                  ƒ  (Dynamic)
├ ○ /login                                                    server-rendered
├ ◐ /posts                                                    on demand
├ ○ /register
└ ◐ /upload
```

Six routes are fully static, six are partially prerendered, and only the three
API handlers are dynamic.

## The prerequisite nobody had measured

`src/app/layout.tsx` awaited `auth()` at the root of the tree. Because that
reads cookies, **it made every route in the application dynamic** — including
the ones Phase 5 marked done as ISR.

`/blog`'s `export const revalidate = 60` had never taken effect. The build's
route table showed no `Revalidate` column for it at all: the page was rendered
on demand for every request, for as long as that call was in the layout. The
Phase 5 ISR items were written but not in force, and nothing failed.

The root layout awaited the session only to hand it to `<SessionProvider>`, and
nothing in the repository calls `useSession()`. The read is gone. That single
change is what turns six routes static, and it is worth having whether or not
PPR is ever enabled.

## What changed in Next 16

The spec item was written against the Next 15 API, where PPR was opted into per
route:

```ts
// next.config.ts — Next 15
experimental: {
  ppr: "incremental";
}
```

```ts
// app/some/page.tsx — Next 15
export const experimental_ppr = true;
```

That API is gone. Setting it on 16.2.12 fails the build outright:

```
[Error: `experimental.ppr` has been merged into `cacheComponents`. The Partial
Prerendering feature is still available, but is now enabled via
`cacheComponents`. Please update your next.config.ts accordingly.]
```

PPR is now one behaviour of **Cache Components**, enabled repo-wide:

```ts
// next.config.ts — Next 16
const config: NextConfig = {
  cacheComponents: true,
};
```

The critical difference is the type. In Next 15, `ppr` accepted
`boolean | "incremental"`, and `"incremental"` meant _nothing changes until a
route opts in_. In 16 the option is declared `cacheComponents?: boolean`
(`node_modules/next/dist/server/config-shared.d.ts`) and validated as
`z.boolean().optional()`. **There is no incremental mode and no per-route
opt-in.** Turning it on turns it on for all 14 routes at once, and every route
must satisfy the new model before the build passes. That is why this landed as
one change rather than a staged rollout.

## What Cache Components demanded of this repo

### 1. Route segment config is rejected

`revalidate` and `dynamicParams` are hard compile errors:

```
./src/app/blog/[slug]/page.tsx:16:14
Route segment config "dynamicParams" is not compatible with
`nextConfig.cacheComponents`. Please remove it.
```

The window moves off the route and onto the function that fetches the data, in
`src/lib/cache/blog.ts`:

```ts
export async function getCachedPublishedPosts(): Promise<
  Stamped<PostSummary[]>
> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 31536000 });
  cacheTag(BLOG_POSTS_TAG);

  return { data: await getPublishedPosts(), renderedAt: new Date() };
}
```

This is a better fit than the route config it replaces. Two routes reading the
same posts now share one cache entry instead of each keeping its own timer, and
`stale` expresses something `export const revalidate` could not: how long a
_client_ may reuse its copy before checking back.

Only the two genuinely public reads are cached. `"use cache"` is deliberately
**not** applied to `@/lib/dal/posts` wholesale — the dashboard reads the same
table scoped to the signed-in user, and caching a per-user query behind a shared
key would serve one user's posts to another.

`dynamicParams` simply has nothing left to say: on-demand generation of unknown
slugs is the default for a dynamic segment.

### 2. On-demand invalidation moves from paths to tags

`revalidatePath("/blog")` became `updateTag`. The unit of invalidation is the
cache entry rather than the URL, so `src/actions/blog.ts` no longer has to know
which routes happen to render the data.

That fixed a real staleness bug on the way: `revalidatePath("/blog")` never
covered `/blog/[slug]`, so publishing an edit left every individual post page
serving its old copy until its own 5-minute TTL expired.

`updateTag` rather than `revalidateTag`: both work, but only `updateTag` gives
read-your-own-writes. `revalidateTag(tag, profile)` expires the entry and lets
the _next_ request refill it, so the person who just clicked "Revalidate now"
could still be served the stale copy they were trying to clear.

### 3. `generateStaticParams` may no longer return an empty array

```
[Error [EmptyGenerateStaticParamsError]: When using Cache Components, all
`generateStaticParams` functions must return at least one result.
```

`app/blog/[slug]` used to `return []` when the database was unreachable. CI
builds against a freshly `db push`ed, empty Postgres service container, so it
returned `[]` on **every CI run** — building "successfully" while prerendering
nothing.

`prisma/seed.ts` is now written (it was referenced by `prisma.config.ts` and had
never existed) and the CI build job seeds before building. The `try`/`catch`
fallback is gone: if the build cannot enumerate posts, the build is wrong and
should say so.

### 4. The current time is a dynamic read

Both blog pages computed `new Date()` in the component body for the "Rendered
at" badge. Under Cache Components that is per-request input the prerenderer
refuses to bake into a shell. The timestamp moved inside the cached function,
which is also more truthful: the badge now shows when the _data_ was computed,
which is what a reader of an ISR demo wants to know.

### 5. Session reads need a boundary — and the boundary's placement is the work

Ten server-side call sites read the session. Nine already sat inside a
`loading.tsx`, which Next treats as a Suspense boundary for the segment, so they
needed no change.

The tenth was the one that mattered. `(dashboard)/layout.tsx` awaited
`getRequiredSession()` in its body, which put the entire chrome — sidebar,
navigation, header, and the page inside it — behind the session read. The build
was perfectly happy. The route table said `◐`. And the static shell for
`/posts` was **2,620 bytes containing a `<title>` and nothing else**.

The fix is `src/components/session/user-chip.tsx`: the layout is synchronous and
renders `<AppShell>` directly, with only the signed-in identity behind a
boundary.

```tsx
<AppShell
  appName="App"
  headerSlot={
    <Suspense fallback={<UserChipSkeleton />}>
      <UserChip />
    </Suspense>
  }
>
  {children}
</AppShell>
```

`/posts` now prerenders 7,154 bytes including the full navigation.

> **A security note.** The session read in that layout was also doing duty as an
> authorisation check, and two routes leaned on it: `/images` and `/upload` are
> absent from `PROTECTED_PREFIXES` in `auth.config.ts`, so the proxy does not
> gate them. Both now call `getRequiredSession()` themselves, covered by
> `src/app/(dashboard)/auth-guards.test.ts`. That is where the check belonged
> anyway — Next does not re-render a shared layout when the user navigates
> between sibling routes inside it, so a layout-level check is skipped on
> exactly those navigations.

## Tradeoffs

**What you gain.** A CDN-servable first byte on personalised routes; the shell
paints while the dynamic holes are still being computed. The win scales with how
slow the dynamic part is — a 400 ms session-plus-query page benefits enormously,
a page whose hole resolves in 5 ms barely moves.

**What you pay.**

- _All-or-nothing adoption._ No incremental mode in Next 16. Every route must
  comply before any route benefits, so the migration cannot be staged behind a
  flag and landed piecemeal.
- _A stricter mental model._ Uncached is dynamic; caching is explicit via
  `"use cache"`. More honest than route-level `revalidate`, but a different
  model every future contributor has to learn.
- _Suspense boundaries become load-bearing._ A boundary in the wrong place
  silently enlarges the hole. This is invisible in code review and invisible in
  the route table — `/posts` reported `◐` while prerendering nothing. Only the
  bytes on disk tell you, which is why CI now reads them.
- _Fallback UI is required, not optional._ Every hole needs a skeleton matching
  the real content's dimensions, or the shell paints and then visibly reflows.
- _Build-time data becomes mandatory._ `generateStaticParams` must yield rows,
  so CI needs a seeded database — infrastructure work, not app work.
- _A client round trip for the session._ `<SessionProvider>` no longer receives
  a server-rendered session, so it fetches `/api/auth/session` on mount, for
  signed-out visitors too. Pass a `session` explicitly on a subtree that is
  already dynamic and already has one in hand.
- _Still experimental._ `cacheComponents` has already been renamed twice
  (`ppr` → `dynamicIO` → `cacheComponents`). Pinning to it is a bet on a moving
  API.

**When it is not worth it.** If a route is fully static already, PPR adds
nothing. If a route is entirely personalised above the fold, the shell is mostly
skeleton and streaming SSR gets you most of the same benefit for none of the
migration cost.

## The gate

`scripts/assert-route-shape.ts` runs after `pnpm build` in CI. It reads
`.next/prerender-manifest.json` and the prerendered HTML, and fails if:

- a route that should be static is missing from the manifest (something above it
  started reading cookies);
- an ISR route lost its revalidation window;
- `generateStaticParams` prerendered nothing;
- a PPR shell no longer contains the navigation it is supposed to prerender.

The last check reads bytes rather than metadata on purpose. Under Cache
Components the manifest marks _every_ route `PARTIALLY_STATIC` — a fully static
page and a shell containing only a `<title>` are indistinguishable in it.

Reintroducing the old `(dashboard)/layout.tsx` and rebuilding produces:

```
Route shape regressed — 5 route(s) did not build as expected:

  /posts
    the shell prerendered 2620 bytes but is missing "Dashboard", "Upload".
    The boundary is too high: content that does not depend on the request is
    being streamed instead of prerendered, so the 'static shell' is a
    near-empty page.
    expected because: the posts shell must prerender its navigation; only
    <UserChip> may stream
```

## Reproducing the measurements

```bash
pnpm install
pnpm db:generate
pnpm exec prisma db push
pnpm db:seed
pnpm build                              # route table
pnpm exec tsx scripts/assert-route-shape.ts
wc -c .next/server/app/posts.html       # the shell, in bytes
```
