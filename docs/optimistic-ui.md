# Optimistic UI

`useOptimistic` and `useActionState`, on the post editor at `/posts/[id]`.

Both hooks are about a mutation in flight, and they own different halves of it:

| Hook             | Owns                                                 | Reset by                        |
| ---------------- | ---------------------------------------------------- | ------------------------------- |
| `useActionState` | the **result** — pending flag, field errors, message | React, when the action resolves |
| `useOptimistic`  | the **displayed server state** during the round trip | React, when the transition ends |

`src/app/(dashboard)/posts/[id]/_components/post-editor.tsx` uses both against
two real mutations: `updatePostAction` (a form save) and `togglePublishAction`
(a button).

## Rollback is not a branch anyone writes

This is the part worth internalising, because the code that implements it looks
like nothing at all.

`useOptimistic(post, reducer)` returns `post` with the pending patch merged over
it. React throws the patch away the moment the transition that applied it ends,
and re-reads `post`. So:

- **the save fails** → `post` never changed → the discard puts the stored title
  back on screen. There is no `catch` that restores anything.
- **the save succeeds** → `post` has been refreshed with the saved row → the
  discard swaps an optimistic value for an identical real one, and nothing
  visibly happens.

Which means the rollback is free and the _success_ path is the one with a
prerequisite: `post` has to have caught up before the transition ends. That is
what `invalidate()` is for, and it is why a mutation that skips its cache work
produces a UI that flickers back to stale data at the end of every successful
save — the symptom looks like an optimistic-update bug and is a cache bug.

`src/actions/posts.test.ts` pins the half of that the action controls: an edit
to a published post drops its blog tags, and an edit to a draft drops none but
still reaches `refresh()`, which is what re-renders the editor's own Server
Component.

## Apply the patch inside the transition

An optimistic update belongs to the transition it was applied in. Outside one it
is an ordinary state update that never rolls back — and "outside one" includes
_after the first `await` of an async transition_, which is the trap:

```tsx
startTransition(async () => {
  applyOptimistic({ published: true }); // ✅ still in scope
  const result = await togglePublishAction(id);
  applyOptimistic({ published: true }); // ❌ scope is gone; this is permanent
});
```

For the form, the scope comes from React itself: a function passed to
`<form action={…}>` runs inside the submission's transition, so applying the
patch there and then dispatching `useActionState`'s action keeps both in the
same transition. The optimistic value survives exactly as long as the save does.

## Controlled inputs, on purpose

React resets an uncontrolled `<form action={…}>` when the action resolves —
**including when it fails**. With `defaultValue`, a rejected save would clear the
draft that caused it at the moment its author most needs it back. So the inputs
are controlled by local state, seeded from the server row once.

Nothing resyncs that state from `post` afterwards, and that is also deliberate.
The obvious "reset the draft when the row changes" effect keys on something like
`updatedAt` — which moves when the _publish toggle_ writes, so hitting Publish
would silently wipe unsaved edits. Text someone is in the middle of typing
belongs to them until they navigate away.

The result is that a failed save leaves two different values on screen at once,
and that is the intended behaviour rather than an inconsistency: the heading
shows what is stored, the textarea shows what was attempted.

## What is optimistic and what is not

Only state the server is authoritative for: the title in the heading and the
Published/Draft pill. Not the inputs (they are the user's, not the server's) and
not `updatedAt` — inventing a save timestamp that the server may never write is
a lie the UI cannot roll back into truth, since nobody can tell a stale
timestamp from a fresh one by looking at it.

An empty title is also not applied. That submission is going to fail its schema,
and blanking the heading for the length of a round trip communicates nothing
that the field error under the input does not.

## Which of the two mutation styles to copy

This repository ships both, and they are not competing:

- **`useOptimistic` + `useActionState`** (`/posts/[id]`) — no client cache, the
  Server Component is the only source of truth, the framework owns the rollback.
  Reach for it first for a form or a single-row screen.
- **TanStack Query** (`/posts`, `src/hooks/use-posts.ts`) — a client cache with
  `onMutate`/`onError` rollback you write yourself, plus refetching, retries and
  shared state across components. Worth its weight when several screens read the
  same list, or when you need cached data to outlive a navigation.

The rollback in the first is three words of React; in the second it is a
`previous` snapshot restored by hand in `onError`. That difference is most of
the decision.

## Testing it

Assertions about an optimistic value are assertions about a _frame_: it exists
only while the transition is pending. So the tests hand the mocked action a
promise they settle by hand
(`src/app/(dashboard)/posts/[id]/_components/post-editor.test.tsx`), which is
what makes the pending state observable at all. A mock that resolves
immediately would leave every one of those tests passing vacuously.

Settle the promise inside `act(...)`, or the re-render it causes lands after the
test ends and React says so on stderr.

## Not done

- **No E2E coverage.** Asserting the rollback end to end needs a server that can
  be made to reject a specific save on demand; the unit tests cover the same
  state machine with the action mocked.
- ~~**No conflict detection.**~~ Done: the save carries the `Post.version` it
  read, a save whose row has moved comes back `conflict` rather than
  overwriting, and the editor offers a three-way merge. See
  [optimistic-concurrency.md](./optimistic-concurrency.md). One consequence
  belongs here: the heading and the pill now render from `basis` — the newest
  row the component knows about, which is the `post` prop, the row the last save
  returned, or a row adopted from a conflict resolution, whichever has the
  highest version — rather than from `post` alone. The rollback story above is
  unchanged (a failed save moves none of the three), and the flicker argument
  still applies to everything the prop feeds that a save's own result does not.
- **No idempotency.** A double-submitted save writes twice. Also its own item.
