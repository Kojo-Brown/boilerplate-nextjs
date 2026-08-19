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
