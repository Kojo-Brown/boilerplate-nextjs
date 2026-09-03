# boilerplate-nextjs

> Next.js 16 · App Router · TypeScript 6 · TailwindCSS 4 · Prisma 7 · NextAuth v5

Full-stack Next.js starter with server components, server actions, auth, and database wired up.

## Stack

| Layer         | Tech                  | Version |
| ------------- | --------------------- | ------- |
| Framework     | Next.js (App Router)  | 16.2    |
| Language      | TypeScript            | 6.0     |
| Styles        | TailwindCSS           | 4.3     |
| Database      | PostgreSQL via Prisma | 7.8     |
| Auth          | NextAuth.js           | v5      |
| Client state  | TanStack Query        | 5.101   |
| Notifications | Sonner                | 2.0     |

## Requirements

Node **22.12+** or **24** (`engines.node` is `^22.12.0 || ^24.0.0`), and pnpm 10.
CI runs lint, typecheck, tests, and the production build on both majors — if you
add or drop a major, change `engines.node` and the matrix in
`.github/workflows/ci.yml` together.

## Quick Start

```bash
git clone https://github.com/Kojo-Brown/boilerplate-nextjs.git
cd boilerplate-nextjs
pnpm install

cp .env.example .env  # fill in DATABASE_URL, NEXTAUTH_SECRET

pnpm db:generate && pnpm db:migrate
pnpm dev  # http://localhost:3000
```

## Project Structure

```
src/
├── app/
│   ├── (auth)/          # Login, register pages
│   ├── (dashboard)/     # Protected pages
│   ├── layout.tsx       # Root layout
│   └── page.tsx         # Home page
├── actions/             # Server Actions
├── components/
│   ├── layout/          # Nav, Sidebar, Footer
│   └── ui/              # Design system primitives
├── hooks/               # Client hooks
├── lib/
│   ├── actions.ts       # ActionResult<T> helpers
│   ├── env.ts           # Zod-validated env vars
│   └── prisma.ts        # Prisma singleton
├── styles/
│   └── globals.css      # TailwindCSS + design tokens (@theme inline)
└── types/               # Shared types
prisma/
├── schema.prisma        # User, Account, Session, Post
└── seed.ts
```

## Patterns

**Server Action:**

```ts
"use server";
import { ok, err } from "@/lib/actions";
export async function createPost(data: {
  title: string;
}): Promise<ActionResult<Post>> {
  try {
    const post = await prisma.post.create({
      data: { ...data, authorId: session.user.id },
    });
    return ok(post);
  } catch {
    return err("Failed to create post");
  }
}
```

## Rendering

Partial Prerendering is on (`cacheComponents: true`). Six routes are fully
static, six are a prerendered shell with server-streamed holes, and only the API
handlers are dynamic.

Two rules follow from it:

- **Caching is explicit.** Uncached data is dynamic. A route no longer declares
  `export const revalidate`; the window goes on the function that fetches the
  data, via `"use cache"` + `cacheLife` — see `src/lib/cache/blog.ts`. Invalidate
  by tag (`updateTag`), not by path.
- **Where you read the session decides what prerenders.** A session read in a
  layout body puts everything below it in the hole. Keep the read in a component
  behind its own `<Suspense>`, as `(dashboard)/layout.tsx` does with
  `<UserChip>`, and never rely on a layout for authorisation — Next does not
  re-render it when navigating between sibling routes.

`pnpm exec tsx scripts/assert-route-shape.ts` runs in CI after the build and
fails if a static route goes dynamic, an ISR window disappears, or a shell stops
prerendering its navigation.
[docs/partial-prerendering.md](./docs/partial-prerendering.md) has the full
tradeoff guide and the measurements.

## Streaming

Prerendering a route is not the same as prerendering a _page_. Every dashboard
route here satisfied the route-shape gate while shipping a document made of the
sidebar and grey boxes, because each page opened with `await
getRequiredSession()` and everything below it — headings, card chrome, field
labels, and 12 KB of literals on `/images` — was therefore absent from the built
HTML.

The rule is that a `<Suspense>` boundary belongs directly around the read, not
around the page: a page component that is `async` has its whole body behind the
await no matter how many boundaries are inside it. `loading.tsx` and the page
now share one frame component and one fallback each, so a client navigation
paints what the shell contains.

`pnpm exec tsx scripts/assert-streaming-boundaries.ts` runs in CI after the
build and fails if a page's own markup is missing from its prerendered document,
if the request-scoped reads have stopped being holes, or if a boundary rendered
an empty fallback. [docs/streaming.md](./docs/streaming.md) has the
before-and-after measurements and where access checks go once a page prerenders.

## Routing

`/photos` demonstrates **intercepting routes**: clicking a photo opens it in a
modal and the URL becomes `/photos/<id>`; reloading that URL, or opening it in
a new tab, renders a full page instead. Same route, two renderings, chosen by
how you arrived.

```
app/@modal/(.)photos/[id]/page.tsx   soft navigation → modal
app/photos/[id]/page.tsx             hard navigation → full page
```

The point is that a `useState` dialog has no URL, so it cannot be shared,
reloaded, or closed with the Back button. Here closing the modal _is_ a
`router.back()`.

Every way of breaking this is silent — a wrong `(.)` marker, a misplaced
`@modal`, or a root layout that stops rendering `{modal}` all still compile and
still serve the right URLs. `src/app/photos/interception.test.ts` asserts the
wiring for that reason.
[docs/intercepting-routes.md](./docs/intercepting-routes.md) has the full
walkthrough.

## API routes

Every handler under `src/app/api/` is built on `defineRoute` (or
`defineAuthedRoute`) from `src/lib/api/`. The handler returns **data, not a
`Response`** — which is what makes the success payload a type a client can
import — and the wrapper owns Zod validation, a single error envelope
(`{ error: { code, message, fieldErrors? } }`), and the rule that `redirect()`,
`notFound()` and React's prerender interrupt are rethrown rather than caught.

```ts
export const GET = defineRoute<PhotoListPayload, Query>({
  query: z.object({ q: z.string().optional() }),
  handler: ({ query }) => searchPhotos(query.q),
});
```

**Per-route `export const runtime` does not build here.** Cache Components
rejects the segment config outright — for `"nodejs"` as well as `"edge"` — so
every route handler runs on Node and edge behaviour belongs in `src/proxy.ts`.
What the repository holds itself to instead is `src/lib/api/runtimes.ts`, which
declares each route's runtime _and_ whether its module graph is free of
Node-only dependencies. That second property is why `defineAuthedRoute` is a
separate module rather than an `auth: true` flag: `/api/health` and
`/api/photos` trace 100 files and no non-framework package, `/api/posts` traces
200 and pulls in Prisma and `pg`.

`pnpm exec tsx scripts/assert-api-runtimes.ts` runs in CI after the build and
fails if a route is undeclared, missing, on a runtime it did not declare, or
claiming portability while tracing Node-only packages.
[docs/route-handlers.md](./docs/route-handlers.md) has the reproduction, the
citation, and the two defects the build caught in the wrapper itself.

## On-demand revalidation

`/blog/[slug]` prerenders one page per published post via `generateStaticParams`
and refills on a `cacheLife` window. `POST /api/revalidate` is how a change made
**outside** the application — a CMS, a migration, a restored backup — clears
those entries before the window expires.

```
x-revalidate-signature: t=1774483200,v1=<hex>   HMAC-SHA256 over "<t>.<raw body>"
{ "event": "post.published", "postId": "…" }  →  { "revalidated": true, "tags": [...] }
```

Three decisions carry it. The signature covers the **raw bytes**, which is why
this is the one handler not built on `defineRoute` — a wrapper that parses the
body leaves nothing to verify against, and re-serialising the parsed value is
not the same bytes. The **timestamp is inside the signed material**, so it
cannot be rewritten to refresh a captured delivery. And the handler calls
`revalidateTag(tag, { expire: 0 })` rather than the `updateTag` every Server
Action here uses, because `updateTag` throws E872 outside a Server Action and
`refresh()` throws E870 — both invisible to a unit suite, since mocking
`next/cache` is exactly what stops them throwing.

That last one is why `e2e/revalidate-webhook.spec.ts` writes a published post
straight through Prisma, confirms `/blog` does not show it, posts a signed
event, and confirms it appears — the only place the claim is actually tested.
[docs/on-demand-revalidation.md](./docs/on-demand-revalidation.md) has the event
table, what the replay window does and does not bound, and why the wire
vocabulary is not `CacheMutation`.

## Draft mode

`/blog` serves published posts from a 60-second cache. A **signed preview
token** opens a draft session in which the same routes serve unpublished content
uncached, with a banner across the top and a `Draft` label on anything not live.
Authors mint links from the **Preview** button on `/posts`; the token is what an
external CMS's preview button would carry.

```
createPreviewLinkAction  →  /api/preview?token=…  →  307 to the signed path
   session + ownership        verify + enable()        drafts, uncached
```

Two decisions carry the design. The **destination is inside the signature**, so
a preview link is not an open redirect and cannot be repointed at another post —
Next's own guide reads it from the query string, which is both. And the read
layer branches **outside** `"use cache"`, so a draft response can never become a
cache entry the public shares.

Reading `draftMode().isEnabled` is not a tracked dynamic access — unlike
`cookies()`, `headers()` or `searchParams` — which is the whole reason this
works without costing `/blog` its static prerender. `cookies()` in a page body
would have.

The unit suite cannot prove the parts that matter (that the cookie survives the
redirect, that it actually changes what the server sends, that a reader without
one sees nothing), so `e2e/preview.spec.ts` drives the flow in a real browser
against a production build. It earned its keep on the first run: it caught an
unpublished post being served to an anonymous request with a 200.
[docs/draft-mode.md](./docs/draft-mode.md) has the flow, the leak, and what the
token's expiry does and does not bound.

## Optimistic UI

`/posts/[id]` is the editor, and the reference implementation of `useOptimistic`

- `useActionState` over two real mutations: a form save (`updatePostAction`) and
  a publish toggle (`togglePublishAction`).

The two hooks split the work. `useActionState` owns the **result** — pending
flag, Zod field errors, the message. `useOptimistic` owns the **displayed server
state** — the heading and the Published/Draft pill.

Rollback is not a branch anyone writes. React discards the optimistic patch when
the transition ends and re-reads the server value, so a rejected save puts the
stored title back on its own. Which makes the _success_ path the one with a
prerequisite: the Server Component has to have been refreshed by then, or the
discard shows stale data for a frame. A mutation that skips its cache
invalidation therefore produces a flicker that looks like an optimistic-update
bug and is a cache bug.

Two smaller traps are load-bearing. An optimistic update applied **after the
first `await`** of an async transition has left that transition's scope and
never rolls back. And React resets an uncontrolled `<form action={…}>` when the
action resolves — _including on failure_ — so the inputs here are controlled,
because a rejected save must not clear the draft that caused it.

[docs/optimistic-ui.md](./docs/optimistic-ui.md) has the full account, plus when
to reach for this over the TanStack Query mutations on `/posts` — this
repository ships both on purpose.

## Optimistic concurrency

The editor posts a whole document minutes after reading it, so every write to
that row in between is invisible to it. Left alone that is a **lost update**: two
people edit one post, the second save quietly erases the first, nothing errors
and nothing is logged.

`Post.version` is the token that makes it detectable. The editor sends the
version it read, and the save is one statement that matches on it —
`UPDATE … WHERE id = $1 AND version = $2` — so a row somebody else has written
since matches nothing and no data is overwritten. The check is inside the write
rather than a read before it, because "look, then act" is not a check under
concurrency.

Detection alone would only be a save button that fails, so a rejected save comes
back carrying the row it found, and the editor compares three versions of every
field: the one it loaded, the one in the browser, and the one in the database.
Fields only one side touched resolve on their own — they retitled the post while
you rewrote the body, and neither is a conflict — and the panel asks about what
is genuinely contested, with both texts on screen. Applying a resolution loads
the merge into the editor and rebases it, rather than saving it: a merge nobody
has read yet is not something to write over somebody else's work.

[docs/optimistic-concurrency.md](./docs/optimistic-concurrency.md) has the
mechanism, the three ways a conditional write can match nothing, and what the
version column deliberately does not cover.

## Styling

TailwindCSS 4 compiled through PostCSS. Design tokens live in `:root` / `.dark`
in `src/styles/globals.css` as ordinary CSS custom properties, and an
`@theme inline` block publishes them into Tailwind's colour namespace so
`bg-primary`, `text-muted-foreground` and `ring-border` generate.

`postcss.config.mjs` is the whole switch, and it is worth knowing why it has a
section here. Without it Next never runs PostCSS: it hands stylesheets to
Lightning CSS, which resolves `@import "tailwindcss"` and drops every directive
it does not understand. No error, no warning — just a 1,103-byte stylesheet and
14 unstyled routes, which is how this repository shipped for six weeks with
every check green.

`pnpm exec tsx scripts/assert-css-output.ts` runs in CI after the build and
fails if the emitted CSS is missing its utilities or still carries Tailwind's
own at-rules. [docs/styling.md](./docs/styling.md) has the token conventions and
the full account of the failure.

## CI

Every gate is warning-fatal — a warning fails the job rather than scrolling past:

| Gate                                | How warnings fail it               |
| ----------------------------------- | ---------------------------------- |
| `pnpm install`                      | `--strict-peer-dependencies`       |
| `pnpm lint`                         | `eslint --max-warnings 0`          |
| `pnpm typecheck` / `test` / `build` | `pnpm run strict <cmd>`            |
| the same three, plus `lint`         | `NODE_OPTIONS=--throw-deprecation` |

`pnpm run strict <cmd>` wraps a command with `scripts/fail-on-warnings.ts`,
which mirrors the output, then exits non-zero if it contained a Next.js `⚠`,
a Vitest `DEPRECATED` banner, a Node process warning, or a package-manager
`WARN`. Tools like `next build` and `vitest run` print these and still exit 0.

`--throw-deprecation` is set per step, not workflow-wide: a workflow-level
value is inherited by JavaScript actions too, and `pnpm/action-setup` calls a
deprecated Node API during setup. It is also off for `pnpm install`, whose own
gate is `--strict-peer-dependencies`.

Run it locally the same way CI does:

```bash
pnpm run strict pnpm build
```

Require the aggregate **CI** check in branch protection, not the individual
matrix legs — their names change whenever a Node major is added or dropped.

## Spec Progress

See [SPEC.md](./SPEC.md).
