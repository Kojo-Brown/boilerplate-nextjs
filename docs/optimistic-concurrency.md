# Optimistic concurrency

`Post.version`, the conditional write in `updatePostAction`, and the panel the
editor shows when a save loses the race.

## The failure this closes

The editor at `/posts/[id]` reads a row, someone edits it for a few minutes, and
the save posts a whole document back. Any write to that row in between is
invisible to it:

```
10:00  A opens the post           title "Draft", body "…"
10:01  B opens the post           title "Draft", body "…"
10:02  B fixes the title          title "Q3 report"
10:05  A saves                    title "Draft", body "… (rewritten)"
```

B's title is gone at 10:05. No error was raised, nothing was logged, both saves
succeeded, and the only surviving record that B ever made the change is in B's
browser until they reload. This is a **lost update**, and it is the one
concurrency bug that a test suite, a type system and a code review all agree is
fine.

Locking is the other answer and it is the wrong one here: a lock taken while a
human writes prose is held for minutes, has to be released by a browser that may
simply close the tab, and turns "two people edited the same post" from an
occasional merge into a queue. Optimistic concurrency assumes the collision is
rare — which for a post editor it is — and pays only when it happens.

## The mechanism

`Post.version` is an integer that starts at 1 and increments on every save. The
editor sends the version it read, and the write matches on it:

```sql
UPDATE posts SET title = $1, content = $2, version = version + 1
 WHERE id = $3 AND "authorId" = $4 AND version = $5
RETURNING …
```

If somebody else has saved since, `version` has moved, the `WHERE` matches
nothing, and the statement updates zero rows without writing anything.

Three details are load-bearing.

**The check is inside the `UPDATE`.** Reading the row, comparing the version and
then writing is two statements, and the window between them is exactly the
concurrent save being guarded against. The same argument as the unique index
behind `IdempotencyKey`: "look, then act" is not a check under concurrency.

**The increment is inside the `UPDATE` too.** `version: currentVersion + 1`
computed in JavaScript is a number derived from a read, so two writers can
compute the same next version. `version = version + 1` is evaluated by Postgres
under the row lock it already holds.

**`updateManyAndReturn`, not `update`.** Prisma's `update` accepts the same
filtered `where` and throws `P2025` when nothing matches — exception-shaped
control flow for an expected outcome, and a `catch` that still cannot say
whether the version moved or the row was deleted. An empty array says the same
thing without pretending anything went wrong. Both compile to the one statement
above.

## Three ways a save can match nothing

The empty result is not self-explaining, so `updatePostAction` re-reads the row —
on the conflict path only — and distinguishes:

| What the re-read finds       | Outcome                           |
| ---------------------------- | --------------------------------- |
| the row, with different text | `{ status: "conflict", current }` |
| the row, already saying this | `{ status: "saved", post }`       |
| nothing                      | `ActionError("Post not found.")`  |

The middle row is the ordinary double-submit — two clicks, or a retry after a
response that never arrived. The first attempt landed and moved the version, so
the second one's token is stale _because of its own success_. Without that
branch every double-clicked save would end in a conflict panel offering a choice
between two identical documents.

A conflict is reported as a **successful** `ActionResult`, not an `ActionError`.
The failure half of `ActionResult` carries a sentence, and a conflict the UI can
act on has to carry a row.

## Resolution is a three-way merge

`src/lib/concurrency/post-conflict.ts` compares three versions of every field:
the one the editor loaded (`base`), the one in the browser (`mine`), and the one
now in the database (`theirs`).

| base = mine | base = theirs | answer                              |
| ----------- | ------------- | ----------------------------------- |
| yes         | yes           | nobody touched it — keep it         |
| yes         | no            | only they changed it — take theirs  |
| no          | yes           | only I changed it — keep mine       |
| no          | no            | both changed it — ask, unless equal |

The third and fourth rows are the point. Compared pairwise, two documents that
differ in the title and the body look like two conflicts, and the author is made
to choose which colleague's work to destroy. Compared against what both started
from — they retitled, I rewrote the body — neither field is contested and the
merge is exact. Most real conflicts in a post editor are of exactly this shape.

What is left over is genuinely contested and the panel asks about it, one choice
per field, with both texts on screen. An unrecorded choice defaults to `"mine"`:
their version is in the database and survives not being picked, the draft in
this browser is not.

## Why resolving does not save

"Save merged version" would be one click fewer. It would also write a document
neither person wrote, assembled seconds ago from radio buttons, over a row the
other author may still have open — turning one lost update into two.

So applying a resolution loads the result into the editor, rebases the draft on
the version it was reconciled against, and hands back an ordinary unsaved draft.
The author reads it, edits it further if they want, and presses the Save button
they were already pressing.

The rebase is the half that is easy to leave out: without it the next save still
carries the version this editor originally loaded, is rejected by the same
check, and the panel becomes a loop rather than a way out.

## What the version does not cover

`published` is deliberately outside it. `togglePublishAction` writes that column
and nothing else, so a publish and a save cannot lose each other's work —
Postgres serialises the two `UPDATE`s and each writes only the columns it names.
Making a publish bump `version` would reject an open editor's save over a change
that touched none of its fields.

Two rapid toggles still race with each other (each reads `published`, then flips
it), which is a different bug with a different fix — a write that names the
transition rather than negating a value it read. Not this item's, and worth
being explicit that the version column does not address it.

Nothing here spans more than one row. A version column detects a conflicting
write to _this_ post; it says nothing about invariants across posts, which is
what a transaction is for.

## Where it lives

| File                                            | What it does                                           |
| ----------------------------------------------- | ------------------------------------------------------ |
| `prisma/schema.prisma`                          | the `version` column                                   |
| `src/actions/posts.ts`                          | `expectedVersion` in the schema, the conditional write |
| `src/lib/concurrency/post-conflict.ts`          | the three-way comparison, `SavePostOutcome`            |
| `.../posts/[id]/_components/conflict-panel.tsx` | the resolution UI                                      |
| `.../posts/[id]/_components/post-editor.tsx`    | the version the draft is based on                      |

See [optimistic-ui.md](./optimistic-ui.md) for the `useOptimistic` /
`useActionState` half of the same editor, and [idempotency.md](./idempotency.md)
for the neighbouring problem: a repeated submission of the _same_ save rather
than a competing one.
