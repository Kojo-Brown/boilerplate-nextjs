# Partial Prerendering: static shell + streamed dynamic holes

Status: **not enabled.** This document is the tradeoff guide asked for by the
Phase 8 spec item, plus the reason the mechanism half of that item is not
shipped alongside it. Everything below was measured against this repository on
Next.js **16.2.12**, not taken from the docs.

## What PPR promises

One route, two rendering modes. The parts of a page that do not depend on the
request — the chrome, the headings, the empty states — are prerendered at build
time into a **static shell** that a CDN can serve immediately. The parts that do
depend on the request — the signed-in user, a cart, anything reading `cookies()`
or `headers()` — are left as **holes**, wrapped in `<Suspense>`, and streamed in
after the shell has already reached the browser.

The payoff is that a personalised page stops paying full dynamic-rendering
latency for its first byte. Today the choice is per route and all-or-nothing: one
`cookies()` call anywhere in the tree makes the entire route dynamic. PPR makes
the choice per _component_.

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
`z.boolean().optional()`. **There is no incremental mode and no per-route opt-in.**
Turning PPR on turns it on for all 14 routes at once, and every route must
satisfy the new model before the build will pass.

That single fact is what separates this item from a one-afternoon change.

## What Cache Components demands of this repo

Under `cacheComponents: true`, uncached data is dynamic by default and every
dynamic read must sit inside a `<Suspense>` boundary. Three classes of breakage
show up here, in the order the build hits them.

### 1. Route segment config is rejected

`revalidate` and `dynamicParams` are replaced by `"use cache"` with `cacheLife`
and `cacheTag`. Both current uses are hard compile errors:

```
./src/app/blog/[slug]/page.tsx:16:14
Route segment config "dynamicParams" is not compatible with
`nextConfig.cacheComponents`. Please remove it.

./src/app/blog/[slug]/page.tsx:13:14
Route segment config "revalidate" is not compatible with
`nextConfig.cacheComponents`. Please remove it.

./src/app/blog/page.tsx:17:14
Route segment config "revalidate" is not compatible with
`nextConfig.cacheComponents`. Please remove it.
```

These are the Phase 5 ISR items. Migrating them is not a mechanical
find-and-replace: `revalidate = 60` is a time-based TTL on a route, while
`cacheLife` is a profile applied to a cached function, and on-demand
`revalidatePath` is replaced by `cacheTag` + `revalidateTag`. The semantics of
work already marked done in the spec change.

### 2. `generateStaticParams` may no longer return an empty array

```
[Error [EmptyGenerateStaticParamsError]: When using Cache Components, all
`generateStaticParams` functions must return at least one result. This is to
ensure that we can perform build-time validation that there is no other dynamic
accesses that would cause a runtime error.]
```

`src/app/blog/[slug]/page.tsx` deliberately returns `[]` when the database is
unreachable at build time, and CI builds against a **freshly `prisma db push`'d,
empty** Postgres service container — so it would return `[]` on every CI run.
Enabling Cache Components therefore breaks the CI build until the build has real
rows to enumerate. `prisma.config.ts` points its seed at `tsx prisma/seed.ts`,
but **`prisma/seed.ts` does not exist** — the `prisma` directory holds only
`schema.prisma`. So a seeded CI build needs that script written first.

### 3. Every session read needs a Suspense boundary

`auth()` reads cookies. Ten server-side call sites read the session outside any
boundary, and each becomes a build error under Cache Components:

| File                                                    | Call                        |
| ------------------------------------------------------- | --------------------------- |
| `src/app/layout.tsx`                                    | `auth()`                    |
| `src/app/(dashboard)/layout.tsx`                        | `getRequiredSession()`      |
| `src/app/(dashboard)/dashboard/page.tsx`                | `getRequiredSession()`      |
| `src/app/(dashboard)/dashboard/@stats/page.tsx`         | `getRequiredSession()`      |
| `src/app/(dashboard)/dashboard/@activity/page.tsx`      | `getRequiredSession()`      |
| `src/app/(dashboard)/dashboard/@notifications/page.tsx` | `getRequiredSession()`      |
| `src/app/(dashboard)/posts/page.tsx`                    | `getRequiredSession()`      |
| `src/app/(dashboard)/admin/page.tsx`                    | `getRequiredAdminSession()` |
| `src/app/api/posts/route.ts`                            | `auth()`                    |
| `src/app/api/posts/paginated/route.ts`                  | `auth()`                    |

## The prerequisite nobody had measured

`src/app/layout.tsx` awaits `auth()` at the root of the tree. Because that reads
cookies, **it makes every route in the application dynamic** — including the ones
Phase 5 marked done as ISR.

This is measurable today, with no config changes. Current `pnpm build`:

```
┌ ƒ /
├ ƒ /blog
├ ● /blog/[slug]
├ ƒ /login
└ ƒ /register        ƒ (Dynamic) server-rendered on demand
```

Replacing that one `await auth()` with `null` and rebuilding:

```
Route (app)                  Revalidate  Expire
┌ ○ /
├ ○ /blog                            1m      1y
├ ● /blog/[slug]
├ ○ /login
└ ○ /register        ○ (Static) prerendered as static content
```

`/blog` only shows its `Revalidate 1m` column in the second build. The
`export const revalidate = 60` on that page has never taken effect: the page is
rendered on demand on every request. Five routes are static the moment the root
layout stops awaiting the session.

So the repo has a real, pre-existing defect, and it is the same defect PPR would
force us to fix. Fixing it is worth doing **on its own merits**, before and
independently of any PPR work — it is the difference between the ISR items
working and merely being written.

The fix is not a one-liner, which is why it is not folded into this change. The
root layout awaits the session only to hand it to `<SessionProvider session>`.
The options are to let NextAuth's client provider fetch it (costing a
client-side round trip and a flash of signed-out chrome), or to pass the
unawaited promise into a client component that `use()`s it inside a Suspense
boundary. Both change signed-in rendering for every page in the app, which makes
it a deliberate change with its own tests — not a side effect of a docs commit.

## Tradeoffs

**What you gain.** A CDN-servable first byte on personalised routes; the shell
paints while the dynamic holes are still being computed. The win scales with how
slow the dynamic part is — a 400 ms session-plus-query page benefits enormously,
a page whose dynamic hole resolves in 5 ms barely moves.

**What you pay.**

- _All-or-nothing adoption._ No incremental mode in Next 16. Every route must
  comply before any route benefits, so the migration cannot be staged behind a
  flag and landed piecemeal.
- _A stricter mental model._ Uncached is dynamic; caching becomes explicit via
  `"use cache"`. This is more honest than route-level `revalidate`, but it is a
  different model that every future contributor has to learn.
- _Suspense boundaries become load-bearing._ A boundary in the wrong place
  silently enlarges the hole — put one too high and the "static shell" is an
  empty page. This is invisible in code review; it shows up only in the build's
  route table.
- _Fallback UI is now required, not optional._ Every hole needs a skeleton that
  matches the real content's dimensions, or the shell paints and then visibly
  reflows.
- _Build-time data becomes mandatory._ `generateStaticParams` must yield rows,
  so CI needs a seeded database — infrastructure work, not app work.
- _Still experimental._ `cacheComponents` remains an experimental surface; it
  has already been renamed once (`ppr` → `dynamicIO` → `cacheComponents`).
  Pinning to it is a bet on a moving API.

**When it is not worth it.** If a route is fully static already, PPR adds
nothing. If a route is entirely personalised above the fold, the shell is mostly
skeleton and streaming SSR gets you most of the same benefit for none of the
migration cost.

## Migration plan

Sequenced so each step is independently reviewable and independently green. Only
step 5 flips the flag; everything before it is an improvement on its own.

1. **Write `prisma/seed.ts`.** It is already referenced by `prisma.config.ts`
   and missing. Deterministic fixtures, obviously fake.
2. **Seed the database in the CI build job**, after `prisma db push`, so the
   build has rows to enumerate.
3. **Take `await auth()` out of the root layout**, behind its own tests. This
   alone makes five routes static and makes the Phase 5 ISR items real.
4. **Wrap the nine remaining session reads in Suspense boundaries**, each with a
   skeleton sized to its content.
5. **Set `cacheComponents: true`** and migrate `revalidate`/`dynamicParams` to
   `"use cache"` + `cacheLife`/`cacheTag`, converting `revalidatePath` calls to
   `revalidateTag`.
6. **Assert the shape in CI.** Parse the build's route table and fail if a route
   expected to be static regresses to `ƒ`. Without this, step 3 silently undoes
   itself the next time someone awaits a cookie in a layout.

Steps 1–4 are worth doing whether or not PPR is ever enabled.

## Reproducing the measurements

```bash
pnpm install
pnpm db:generate
pnpm exec prisma db push
pnpm build                       # route table: every route ƒ (Dynamic)
```

Then set `cacheComponents: true` in `next.config.ts` and rebuild to see the
three error classes above, in order.
