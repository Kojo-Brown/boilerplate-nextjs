# Transactional writes and the outbox

A mutation here owes an effect to code it does not call. Publishing a post has
to drop the blog's cache entries; tomorrow it will also have to notify a
subscriber and update a search index. This document is about making that
effect happen exactly when the write it describes happened — not before, not
never.

## The two failures of a write followed by an effect

Before this, every post mutation was two steps:

```ts
const post = await prisma.post.create({ … });
invalidate({ kind: "post.created", postId: post.id, published: post.published });
```

That has no failure mode in development and two in production.

**The process dies between them.** The row is committed and the blog keeps
serving a list without it until the entry expires on its own. Nothing anywhere
records that an invalidation was owed, so there is nothing to retry _from_ — the
only evidence is a page that is quietly wrong.

**The effect throws.** This one is worse, because it used to fail the action.
`createPostAction` is idempotent, and `runIdempotent` releases the key when the
handler throws so that a retry may execute. A handler that wrote a row and then
failed in `invalidate()` therefore released a key whose work had already
happened — and the retry wrote a second post. `@/lib/actions/idempotency` names
that hole in its header and points here. Idempotency keys deduplicate
_requests_; they cannot make a handler's own effects atomic.

## The shape

Put the record of the effect in the same transaction as the write:

```ts
const post = await writeWithOutbox(async ({ tx, emit }) => {
  const created = await tx.post.create({ data: { … }, select: postSummarySelect });
  emit({
    type: "post.created",
    payload: { postId: created.id, published: created.published },
  });
  return created;
});
```

`emit` records; it does not dispatch. Everything emitted becomes an
`outbox_events` row in the same transaction as the writes above it, so the event
exists if and only if the write committed. The dispatch — the same
`invalidate()` as before — happens after the commit, and anything it fails to do
is left `PENDING` for the relay.

Three properties follow, and they are the whole point:

| Failure                                  | Before                                                           | Now                                     |
| ---------------------------------------- | ---------------------------------------------------------------- | --------------------------------------- |
| Crash after the write, before the effect | Effect lost, silently                                            | Row is `PENDING`; the relay performs it |
| Effect throws                            | Action fails; an idempotency key is released over committed work | Action succeeds; row stays `PENDING`    |
| Transaction rolls back                   | Effect may already have been announced                           | No row, so no event                     |

## Why the dispatch is inline first

`writeWithOutbox` dispatches its own events immediately after the commit, and
the relay only ever sees what that missed. This is not an optimisation.
`updateTag` — the Server Action path — is the only one of Next's two
invalidation calls that gives read-your-own-writes; `revalidateTag` marks the
entry stale and lets the _next_ request refill it. Waiting for the relay would
mean serving the person who just clicked Publish the copy they were trying to
clear, which is the bug `@/lib/cache/invalidation` exists to fix.

So the relay is the safety net, not the primary path, and the two use different
functions. `@/lib/outbox/dispatch` is where that choice is made, by naming the
context: `updateTag` and `refresh()` throw outside a Server Action (E872, E870),
`revalidateTag` is the one callable from a Route Handler.

## At-least-once

An event is marked processed _after_ its effect. A process that dies in between
leaves the row `PENDING` and the relay dispatches it again. That is inherent —
marking first turns "delivered twice" into "never delivered" — so **every
consumer must be idempotent**. Dropping a cache tag twice is dropping a cache
tag; sending an email twice is not, which is a thing to have decided before the
second consumer is added.

## The relay

`POST /api/outbox`, signed with the same HMAC as `/api/revalidate` (same header,
same secret: the two endpoints have exactly the same authority, since everything
the relay can do is drop tags for events the application itself recorded).

It is an endpoint rather than a worker process because of where Next's cache
lives. `revalidateTag` is a call into the _running server's_ cache handler, so a
standalone Node worker importing the relay would claim rows, dispatch them, mark
them processed, and drop nothing. Point a scheduler at it:

```bash
BODY='{"sweep":true}'
SIG=$(node -e '…')   # see docs/on-demand-revalidation.md for the signer
curl -sS -X POST https://example.com/api/outbox \
  -H "x-revalidate-signature: $SIG" \
  -H 'content-type: application/json' \
  -d "$BODY"
```

The response is a report, not a heartbeat:

```json
{
  "claimed": 3,
  "processed": 2,
  "retried": 1,
  "deadLettered": 0,
  "tags": ["blog:post:abc", "blog:posts"],
  "failures": [
    { "id": "…", "type": "post.updated", "deadLettered": false, "error": "…" }
  ],
  "swept": 12
}
```

A cron whose only feedback is `200 OK` cannot tell "nothing was owed" from "the
relay has been dead-lettering every event for a week".

### Claiming

A claim is `claimToken` + `leaseExpiresAt` written onto a `PENDING` row, the
same mechanism `IdempotencyKey` uses. A worker killed mid-dispatch holds nothing
past its lease, and every write that ends an attempt carries the token in its
`WHERE`, so a pass whose lease expired while it was running cannot conclude
anything about a row somebody else now owns.

It is two statements — select candidates, then a conditional update carrying the
same availability predicate — which can _under_-claim and cannot double-claim.
`SELECT … FOR UPDATE SKIP LOCKED` is the textbook form and would avoid the
wasted round trips; it is raw SQL for a saving that only appears at a
concurrency this application does not have. If several relays ever run
concurrently and the wasted work shows up, that is the change to make, in
`@/lib/outbox/store` alone — the protocol is behind an interface.

### Retries

Full jitter: `delay = random(0, min(cap, 1s · 2^(attempts-1)))`, capped at five
minutes, up to eight attempts. Jittered because events that fail together
usually failed for the same reason, and retrying them at the same instant is how
a recovering dependency is knocked over again; sampled from zero rather than
half the window because that spreads them furthest.

The delay lives in `availableAt` on the row, not in the worker's memory, so it
survives a restart.

After eight attempts the row is `FAILED` — a dead letter, which needs a person.
A payload that does not parse is dead-lettered on its _first_ attempt: no amount
of retrying turns unreadable bytes into readable ones, and spending the budget
to learn that delays every row behind it.

### Retention

`sweep: true` deletes `PROCESSED` rows older than 24 hours. Dead letters are
never swept: a table that quietly deletes its own unresolved failures is worse
than one that grows. There is no scheduler in this application, so nothing runs
on a timer; from cron, the equivalent is

```sql
DELETE FROM outbox_events
WHERE status = 'PROCESSED' AND "processedAt" < now() - interval '24 hours';
```

## Rules the gates enforce

Two properties are invisible at runtime and both fail the build instead
(`scripts/assert-transactional-writes.ts`):

**T1 — the callback uses `tx`, never the imported `prisma`.** This is the
defining bug of the pattern. It compiles, it type checks (both are clients with
the same methods), and it passes every unit test, because the tests mock
`@/lib/prisma` and the transaction client the mock hands back _is_ the same
object. What it does in production is run the statement on a second connection:
it commits independently, is invisible to the transaction's own later reads, and
survives the rollback that was supposed to undo it.

**T3 — only `@/lib/outbox` writes outbox rows.** An event written anywhere else
is a promise of an effect with nothing guaranteeing the write it describes.

T2 is the small rule that keeps the other two honest: the callback must bind its
client as exactly `tx`, no rename. That name is what T1 looks for, and what
`assert-cache-invalidation.ts` counts as a database write — a rename would
switch off two gates while reading as a style preference.

`assert-cache-invalidation.ts` R1 also accepts `emit(…)` alongside
`invalidate(…)`. The duty is unchanged (an action that writes must report what
it wrote); only the mechanism moved.

## Adding a consumer

1. Add the event to `OUTBOX_EVENT_TYPES` and the union in
   `@/lib/outbox/events.ts`, with a payload schema. The schema is not optional:
   the column is `Json`, so what comes out is not the value that went in — a
   `Date` is a string by then — and the relay reads rows nobody is waiting for,
   where a subtly wrong shape is a background failure rather than a visible one.
2. Emit it from the mutation, inside the transaction.
3. Handle it in the consumer. Cache invalidation goes through
   `cacheMutationFor`; anything else is a new function beside it.

Nothing about a producer changes when a consumer is added, which is the reason
the payload is a domain fact ("post 7 was published") rather than a cache
instruction ("drop blog:posts"). A row outlives the code that wrote it.

## What this does not do

- **Ordering.** Rows are claimed oldest-first, but two relays interleave and
  nothing promises a global order. No consumer here needs one; an event type
  that did would need a partition key and a single claimant per partition.
- **Exactly-once.** See at-least-once above. It is a property of the consumer,
  not of this table.
- **A scheduler.** Nothing pokes `/api/outbox` on its own — the deployment's
  cron does. Without one, the outbox is still doing its job for every event
  whose inline dispatch succeeded, and accumulating the rest as `PENDING`, which
  is the failure being visible rather than silent.
- **A dead-letter UI.** `SELECT * FROM outbox_events WHERE status = 'FAILED'` is
  the current tooling.
