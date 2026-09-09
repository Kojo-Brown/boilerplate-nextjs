# N+1: the one the App Router makes, and the one it does not

Status: **done.** Every read a component performs goes through `src/lib/dal/`,
is memoised for the request, and — where it is keyed by id — batched.
`scripts/assert-no-n-plus-one.ts` fails CI if that stops being true.

## Two different problems with one name

The N+1 everybody knows is a list that queries once per row:

```tsx
const posts = await getPosts();
const authors = await Promise.all(posts.map((p) => getUserById(p.authorId)));
// 1 + N statements
```

**This repository never had that one.** Every list read in `src/lib/dal/posts.ts`
pulls its relation through `select`, so the author arrives with the row. That
is the fix, it was already applied, and rule N3 in the gate is what keeps it
applied.

The one it did have is the same arithmetic arranged differently. Server
components ask for what they render; parallel routes and Suspense boundaries
render independently; so N components each ask for the same thing and none of
them can see that the others already did. Measured against a live Postgres,
before this change, **one `/dashboard` request**:

|                                                                        | statements |
| ---------------------------------------------------------------------- | ---------- |
| `@stats` → `COUNT(*)` of the author's posts                            | 1          |
| `@stats` → `COUNT(*)` of their published posts                         | 1          |
| `@notifications` → `COUNT(*)` of their drafts                          | 1          |
| `@notifications` → most recently edited post                           | 1          |
| `@activity` → five newest posts                                        | 1          |
| **`posts` statements for one user**                                    | **5**      |
| session cookie decoded (`UserChip`, greeting, field list, three slots) | **7**      |

Nothing there is a mistake. Each query is correct, indexed, and the smallest
thing the component that wrote it needed. The duplication is a property of the
render, not of any line in it — which is exactly why it survived every test,
every review, and eleven green checks.

Afterwards, same request, same data:

|                                                                       | statements |
| --------------------------------------------------------------------- | ---------- |
| one `GROUP BY "published"`, read by `@stats` **and** `@notifications` | 1          |
| most recently edited post                                             | 1          |
| five newest posts                                                     | 1          |
| **`posts` statements**                                                | **3**      |
| session cookie decoded                                                | **1**      |

## The three mechanisms

### 1. `requestMemo` — the same read, asked for twice

`src/lib/request-memo.ts` wraps a function in React's `cache()`, which memoises
per _request_. Two components asking for the same thing share one execution;
two requests share nothing.

```ts
export const getPostsByUser = requestMemo(async (userId: string) =>
  prisma.post.findMany({
    where: { authorId: userId },
    select: POST_SUMMARY_SELECT,
  }),
);
```

Three things about it are worth knowing before you use it.

**Arguments are compared by identity.** React keys the memo on the argument list
with `SameValueZero`. A read that takes `{ userId }` builds a new object at
every call site, misses every time, and runs once per caller — memoised in the
source and not in production. Rule **N4** fails a memoised signature that takes
anything but primitives.

**Outside a React render it does not memoise at all.** There is no request to
key on, so each call gets a fresh cache. That is why wrapping the data layer
changed nothing about the seed script, the CI gates, or the 1,156-test suite —
and why _no test in this repository asserts the deduplication itself_. The
numbers in the tables above were measured by reading Postgres's statement log
against a running server, which is the only place the property is observable.

**A memoised read is a read.** Within one request the second call returns the
first call's value, so `write → read` gets the state from before the write.
`updatePostAction`'s conflict re-read is the one place that matters, and it
calls `getEditablePost.uncached(…)` with a comment saying why. Rule **N5**
requires the comment.

### 2. `createBatchLoader` — N different keys, one statement

`src/lib/dal/batch.ts` holds keys until the microtask queue drains and issues
one `… WHERE "id" IN (…)`. `src/lib/dal/loaders.ts` is the only place instances
are built, each behind `cache(factory)` so it lives exactly one request.

Measured, again on a live server: four `loadPost` calls spread across two
parallel-route slots — three distinct ids, one of them wanted by both slots —
left as **two** statements, `… WHERE "id" IN ($1,$2)` and one for the third.
Without the loader that is four. The shared id being fetched once is also the
proof that the two slots got the _same_ loader instance, which is what
`cache()` is doing there.

Note what that measurement does _not_ say: the two slots produced two batches,
not one. Batching coalesces what a synchronous pass asks for; components behind
separate boundaries render at separate moments. Deduplication is the guarantee,
batching is the bonus, and a list rendering rows in one pass gets both.

#### Why Prisma's own dataloader is not enough

Prisma batches `findUnique` calls itself, and it works — measured on Prisma
7.9.1 over the `pg` adapter, five of them inside one `Promise.all` leave as a
single `IN (…)`. The conditions are the problem, and all three were measured:

| shape                                            | batched?               |
| ------------------------------------------------ | ---------------------- |
| `findUnique` × N in one `Promise.all`            | **yes**, one statement |
| `findUnique` × N awaited one after another       | no, N statements       |
| `findUnique` × N in one tick, different `select` | no, N statements       |
| `findFirst` × N in one tick                      | no, N statements       |

Prisma's batcher fires exactly when the calls are already in one `Promise.all` —
which was never the N+1. A component tree does not render in a tick, half this
repository's by-id reads are `findFirst` (because they carry an ownership or
`published` predicate `findUnique` will not accept), and two components wanting
different columns of the same row is routine.

### 3. Reads live in the data layer

A query written inside a component is a query no other component can share,
because not sharing is what a component is. Rule **N1** keeps `prisma` out of
`src/app/` and `src/components/` entirely. Server Actions and infrastructure are
deliberately out of scope — the rule is about reads a sibling cannot see, not
about all database access.

## The gate

`scripts/assert-no-n-plus-one.ts`, run in CI:

| rule   | fails on                                                             |
| ------ | -------------------------------------------------------------------- |
| **N1** | a Prisma delegate call under `src/app/` or `src/components/`         |
| **N2** | an exported `src/lib/dal/` read that is not wrapped in `requestMemo` |
| **N3** | `.map(async …)` whose callback awaits a data-layer read              |
| **N4** | a memoised function taking a non-primitive parameter                 |
| **N5** | `.uncached` with no comment saying why                               |
| **N6** | `createBatchLoader` called outside `src/lib/dal/loaders.ts`          |
| **N7** | a loader built at module scope, outliving the request                |

Run against `main`'s own sources it reports fifteen findings: the five component
queries this change removed and the ten unmemoised data-layer reads. A gate that
cannot reproduce the defect it guards is a gate nobody can trust.

N7 is the one that is not about performance. A loader is a cache of rows with no
expiry, which is safe for the length of a request and a cross-user data leak for
the length of a process:

```ts
// Wrong. One instance for every request the process serves — the first
// request's rows, returned to all of them.
const userLoader = createBatchLoader({ … });
```

## Adding a read

1. Put it in `src/lib/dal/`, wrapped in `requestMemo`, taking primitives.
2. If it is keyed by id and a list might want many, add a loader in
   `loaders.ts` and expose `loadThing` / `loadThings`.
3. If a list needs a relation, `select` it with the row. Do not map rows onto
   the loader when one `include` would do — batching N reads into one statement
   is better than N statements and worse than not asking twice.
4. Reading after writing in the same request? `.uncached`, with a comment.

## What is not covered

- **`"use cache"` entries.** `requestMemo` deduplicates within a request;
  `"use cache"` caches across them, and the two do not compose into anything
  either of them promises. `src/lib/cache/blog.ts` is the only place both are in
  play, and the cached functions there call the memoised reads rather than the
  other way round.
- **Route handlers.** They get their own request scope, so a memoised read is
  memoised there too, but none of them reads the same thing twice today and
  nothing measures whether that stays true.
- **The N+1 across a network boundary.** A client component fetching per row
  through TanStack Query is the same arithmetic with worse constants, and no
  rule here can see it.
