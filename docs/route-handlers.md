# Route handlers: a typed API, and where the runtime decision actually lives

Two things live under `src/app/api/`: a small typed layer that every handler is
built on (`src/lib/api/`), and a runtime decision per route that Next 16 will
not currently let this repository make.

Both halves are covered here, because the second one is the more useful
finding and it is not what the spec item asked for.

## The typed layer

A raw App Router handler is `(Request) => Response`. Everything that makes it an
API — parsing the query string, rejecting a bad body, turning a throw into a
status, keeping the shapes in a type — is left to the author. Before this layer
there were two handlers, and they had already diverged: each spelled its own
401 (`{ error: "Unauthorized" }`), neither validated anything, and nothing typed
the failure case.

```ts
export const GET = defineRoute<PhotoListPayload, Query>({
  query: z.object({
    q: z.string().optional(),
    limit: z.coerce.number().max(50),
  }),
  handler: ({ query }) => ({ items: searchPhotos(query.q), total: 3 }),
});
```

The load-bearing decision is that **the handler returns data, not a
`Response`**. That makes the success payload a value with a type, which is what
lets `RouteData<typeof GET>` hand a client the exact shape the server returns,
so a change on one side fails typecheck on the other.

What the wrapper does around it:

| Concern               | Behaviour                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Query / params / body | Parsed by the declared Zod schema; the parsed value is what the handler sees                            |
| Validation failure    | `422` with `fieldErrors` keyed `query.limit`, `body.title`, `params.id`                                 |
| Unparseable body      | `400` — nothing to validate and no field to blame, which is a different failure from a schema rejection |
| Thrown `ApiError`     | Its own status and message                                                                              |
| Any other throw       | `500` with a fixed sentence; the original is logged server-side and never reaches the client            |
| Framework signals     | Rethrown untouched — see below                                                                          |

Every failure is the same envelope, `{ error: { code, message, fieldErrors? } }`,
nested rather than flat so that a success payload containing an `error` field is
still distinguishable from a failure.

### Two defects this layer had, and what they cost

Both were found by running `pnpm build` rather than by the test suite, which is
the argument for having gates that read build output.

**Swallowing React's prerender interrupt.** The wrapper's `catch` caught
everything, and `redirect()`, `notFound()` and React's prerender bailout all
communicate _by throwing_. Next says so in the error text itself: "React throws
this special object to indicate where. It should not be caught by your own
try/catch." The build logged four routes failing with a 500 that were not
failing at all. The fix is `isFrameworkSignal`, which rethrows anything carrying
a screaming-snake-case `digest`.

The first version of that guard matched `NEXT_`-prefixed codes plus
`DYNAMIC_SERVER_USAGE`, from reading the framework source. The very next build
produced `HANGING_PROMISE_REJECTION` — no prefix — thrown when `auth()` reads
headers after a prerender completes. A list of exact codes stops covering
whatever Next adds next, so the guard matches the _shape_, and excludes React's
own numeric digests by requiring a leading letter.

**Reading `searchParams` unconditionally.** The wrapper parsed the query string
before checking whether a route had declared a schema for it. Reading
`nextUrl.searchParams` is a dynamic access, so `/api/health` — which reads
nothing — was bailing out of prerendering because of the wrapper wrapping it.
Inputs are now read lazily: a route touches only what it declared.

## Runtime selection: what Next 16 allows

The spec item asked for "runtime selection (`edge` vs `nodejs`) per route". That
is a `route.ts` segment export:

```ts
export const runtime = "edge";
```

It does not build here:

```
Route segment config "runtime" is not compatible with
`nextConfig.cacheComponents`. Please remove it.
```

`cacheComponents: true` is on repo-wide — it is how Partial Prerendering is
enabled in Next 16, it is typed `boolean`, and it has no per-route opt-in (see
[partial-prerendering.md](./partial-prerendering.md)). The rejection is on the
export _existing_, not on its value: `runtime = "nodejs"` fails identically.
Next's own guidance is that Cache Components requires the Node.js runtime and
that `runtime = "edge"` is deprecated, with per-route edge behaviour directed to
Proxy instead.

So every route handler in this repository runs on Node, and no configuration
available here changes that. **Edge behaviour lives in `src/proxy.ts`** — Next
16's renamed middleware, which still runs close to the user and is where
geo-routing, A/B bucketing and cheap redirect logic belong. What does _not_
belong there is anything that needs a database, a large dependency, or a
response body of its own; the proxy runs on every matched request, and it is one
shared module rather than a per-route decision.

### What is delivered instead

Two things that are real today and that make the runtime decision cheap to
make the day the framework allows it.

**A declaration.** `src/lib/api/runtimes.ts` records, for every route, the
runtime it runs on and whether its module graph is free of Node-only
dependencies:

```ts
{ path: "/api/photos", runtime: "nodejs", portable: true, because: "…" }
```

`portable` is the half that is _not_ forced by the framework, and it is the
property that actually decides whether a route could move. It is a real
distinction here:

| Route                  | Traced files | Non-framework packages              |
| ---------------------- | ------------ | ----------------------------------- |
| `/api/health`          | 100          | none                                |
| `/api/photos`          | 101          | none                                |
| `/api/posts`           | 200          | `@prisma/client`, `pg`, and 17 more |
| `/api/posts/paginated` | 200          | the same                            |

That split is not an accident of what the routes happen to import — it is why
`defineAuthedRoute` is a separate module from `defineRoute` rather than an
`auth: true` flag. A flag would have put the Prisma graph behind every route
built on the helper. Splitting it makes the boundary structural: a route's
imports decide what it can run on, which a reader can see at the top of the file
and a bundler can act on.

**A gate.** `scripts/assert-api-runtimes.ts` runs after every CI build and reads
the build output, not the source:

1. every declared route was built;
2. every built route handler is declared, so a new endpoint cannot appear
   without a runtime decision being recorded;
3. each route's built runtime matches its declaration;
4. every route claiming `portable` traces no package outside `next`, `react` and
   `@swc/helpers`.

Check 4 is an allowlist rather than a list of banned packages, so it fails
closed: reaching for a Node-only library nobody thought to ban still trips it.
Check 3 is currently one-sided — `nodejs` is the only reachable answer — and its
job is to notice if that changes underneath us.

This is the same argument as `scripts/assert-route-shape.ts`, which exists
because a cookie read in a layout silently converted fourteen routes to
on-demand rendering and every check stayed green. The API equivalent is quieter
still: a route's runtime and its portability are properties of its module graph,
so a single added import changes both, changes no line that mentions either, and
builds clean.

### The day the constraint lifts

Flipping a route to the edge becomes: change `runtime` in `API_ROUTES`, add the
segment export, rebuild. The gate is already in place to prove the flip took
effect — which is the part that silently failed to happen for the ISR work, and
the reason the route-shape gate exists at all.
