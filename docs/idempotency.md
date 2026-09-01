# Idempotency keys for Server Actions

A Server Action is a POST, and `createPostAction` is a POST that creates
something. Submitting it twice creates two posts — and the two submissions come
from ordinary accidents, not from an attacker:

- **Two clicks.** `disabled={isPending}` is set in a React commit. A second
  `click` dispatched before that commit lands sees an enabled button.
- **A reload mid-request.** Or a back-then-forward, or a browser's "Confirm Form
  Resubmission".
- **A retry underneath the app.** A phone moving from Wi-Fi to cellular produces
  a request the client believes failed and the server completed.

In all three the server sees two requests that are correctly authorised,
correctly validated, and indistinguishable. The three legs in
`docs/server-actions.md` cannot help: there is nothing in the requests that
differs. The only thing that can distinguish them is a value the client mints
once per submission and repeats on every retry of it.

## Declaring it

An authenticated action opts in by carrying a key in its schema and declaring a
plan:

```ts
const createPostSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  title: z.string().min(1).max(255),
  content: z.string().max(100_000).optional(),
});

export const createPostAction = defineAuthedAction({
  name: "createPost",
  input: createPostSchema,
  idempotency: {
    key: (input) => input.idempotencyKey,
    output: postSummaryOutput,
  },
  handler: async ({ input, user }) => {
    /* … */
  },
});
```

`key` pulls the key out of the _parsed_ input, so it is validated by the
action's own schema and visible in its type — an action whose input has no key
cannot declare a plan and compile. `output` is covered below, and is the part
that is easy to skip and expensive to skip.

The step runs after origin → session → schema, as a fourth leg. It is offered on
`defineAuthedAction` and `defineAuthedFormAction` only: a key is scoped to the
principal that owns it, and without an authenticated one the choices are a
global key space — where one user's key collides with another's and is answered
with their result — or a client-supplied identity, which is not an identity.

## What happens on the second request

Claiming a key is a single `INSERT` against a unique index on
`(scope, action, key)`. That is the whole design. "Does a row exist? No — insert
one" has a window between the two statements, and that window _is_ the
double-submit.

| The insert                           | Answer    | Caller sees                          |
| ------------------------------------ | --------- | ------------------------------------ |
| succeeds                             | claimed   | the handler runs                     |
| conflicts, row completed, same input | replay    | the first result, handler not run    |
| conflicts, row in flight             | in flight | "already being processed, try again" |
| conflicts, different input           | conflict  | "repeat of a different request"      |

The in-flight answer refuses rather than waits. Waiting would hold a server
connection open for the duration of someone else's request, which is how a
double-submit turns into an outage; the caller retries and gets the replay.

The conflict answer is checked _before_ status, so a key reused for a different
payload is refused whether the first request has finished or not — telling a
caller to retry a request that can only ever conflict is worse than telling them
it conflicts.

## The client half, which is where the bug goes

The key identifies **a submission**, not a request, so it is minted once and
held across every attempt at it. This is the version that compiles, reads
correctly, and protects nothing:

```tsx
// ❌ a fresh key per attempt — the second click is just a second post
createPost.mutate({ idempotencyKey: crypto.randomUUID(), title });
```

`create-post-dialog.tsx` holds the key in a ref alongside the payload it belongs
to:

```tsx
const payload = JSON.stringify(input);
const previous = submissionRef.current;
const idempotencyKey =
  previous && previous.payload === payload ? previous.key : newIdempotencyKey();
submissionRef.current = { key: idempotencyKey, payload };

createPost.mutate(
  { idempotencyKey, ...input },
  { onSuccess: () => (submissionRef.current = null) },
);
```

Three consequences, all deliberate:

- A **failed** attempt keeps its key, so the retry is deduplicated against the
  attempt that may have succeeded on the server before the connection dropped.
- A **successful** one clears it, so the next post is a new submission rather
  than a replay of the last one.
- **Editing and resubmitting** mints a fresh key. Reusing one for changed
  content would be a conflict on the server, which is the right answer to the
  wrong question — the user made a new request.

Use `newIdempotencyKey()` from `@/lib/actions/idempotency-key` rather than
`crypto.randomUUID()` directly. `randomUUID` is restricted to secure contexts,
so it is `undefined` on plain `http://` over a LAN address — every "open the dev
server on my phone" setup — and the helper falls back to `getRandomValues`
there. It throws rather than falling back to `Math.random()`: a weak generator
lets two of one user's submissions collide, and the second is then answered with
the first one's result.

## Why the replay needs an output schema

A stored result is a row in Postgres, so it is JSON, so it is not the value the
handler returned:

```ts
// fresh:   { createdAt: Date }
// replayed: { createdAt: "2026-01-01T00:00:00.000Z" }
```

A component reaching for a `Date` method on that throws — on the **second**
submission only, which is the least-exercised path in the application. The
`output` schema is what puts the shape back:

```ts
const postSummaryOutput = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  /* … */
});
```

It must describe the handler's return value _exactly_. Zod strips what an object
schema does not declare, so a field the handler returns and the schema omits is
present on the first submission and absent on the replay.
`src/actions/posts.test.ts` pins this by comparing a replayed result against a
fresh one rather than by describing either — the first run of that test failed
on precisely this, against a fixture carrying a field the real `select` does not
return.

The schema buys a second thing: a result recorded by a previous deployment whose
shape no longer parses is **refused**, not returned. Re-running the handler
instead would be the duplicate the whole mechanism exists to prevent.

## Failures release the key

A row is only ever completed for a success. When the handler throws, its row is
deleted and a retry with the same key is allowed to execute — which is what the
cases that actually happen need: a deadlock, a dropped connection, a transient
constraint failure.

**This does not make a handler atomic**, and the gap is worth knowing rather
than discovering. A handler that writes a row and _then_ throws — an
`invalidate()` failing after `prisma.post.create` succeeded — releases the key,
and the retry writes a second row. Idempotency keys deduplicate requests; the
item that makes a handler's own effects atomic is transactional writes with an
outbox row, further down `SPEC.md`. Until then, an idempotent handler should do
its writing in one Prisma call or one interactive transaction.

## Leases, retention, and the claim token

`expiresAt` means "when this row stops being authoritative", and what that
implies depends on `status`:

- **`IN_PROGRESS`** — a _lease_, 60s. An attempt that died between claiming a
  key and recording its result would otherwise hold that key forever and the
  caller could never retry. After the lease, another attempt takes the row over.
- **`COMPLETED`** — the _retention window_, 24h. After it, the key is free and a
  very late retry re-executes rather than replaying.

`claimToken` is what makes the lease safe. An attempt that stalls past its lease
is taken over, and then wakes up: a `WHERE key = …` alone would let it write its
result over the live claim, or delete the row out from under it on the way to
reporting its own failure. Both writes carry the token, so a claim that has
moved on simply matches nothing.

## Operating it

The table only grows for keys that are never reused, and nothing in this
repository sweeps it — there is no scheduler here to hang that off. A deployment
should run, on whatever it does have (a Vercel cron route, a `pg_cron` job, a
container sidecar):

```sql
DELETE FROM idempotency_keys WHERE "expiresAt" < now();
```

`@@index([expiresAt])` exists for that query. Deleting an expired row is always
safe: an expired row is one any claim would take over anyway.

## Which actions have it

Only `createPostAction`, and that is a decision rather than an omission. Every
other mutation in `src/actions/posts.ts` names the row it acts on: a repeated
`deletePostAction` finds the post already gone and answers "Post not found", and
a repeated `updatePostAction` writes the same values a second time. Neither
leaves a mess. Creating is the mutation with no natural key, which is exactly
why it needs a supplied one.

## Where the code is

| File                                      | Holds                                                |
| ----------------------------------------- | ---------------------------------------------------- |
| `src/lib/actions/idempotency-key.ts`      | key generation and schema — client-safe, no imports  |
| `src/lib/actions/idempotency.ts`          | the protocol, the fingerprint, the store interface   |
| `src/lib/actions/idempotency-store.ts`    | the Postgres implementation                          |
| `src/lib/actions/define-authed-action.ts` | the `idempotency` option on the two authed factories |

The fingerprint is a SHA-256 over a canonical encoding rather than
`JSON.stringify`, which is wrong here in three ways that each turn one request
into a spurious conflict: key order is insertion order, `undefined` vanishes
from objects and becomes `null` in arrays, and a `Map` stringifies to `{}`. See
`canonicalise` for the rules and `idempotency.test.ts` for a case per rule.
