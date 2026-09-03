"use client";

import {
  useActionState,
  useEffect,
  useOptimistic,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import { togglePublishAction, updatePostAction } from "@/actions/posts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { mergeEditable } from "@/lib/concurrency/post-conflict";
import type { EditableFields } from "@/lib/concurrency/post-conflict";
import type { EditablePost } from "@/lib/dal/posts";
import { ConflictPanel } from "./conflict-panel";

/**
 * `useActionState` + `useOptimistic` over the two post mutations, with the
 * rollback both hooks exist for.
 *
 * `docs/optimistic-ui.md` is the long version — why the optimistic update has
 * to be applied *inside* the transition, why rollback is a consequence of the
 * server value not changing rather than a branch anyone writes, and why a
 * mutation that skips its cache invalidation makes a correct optimistic UI
 * flicker. What follows is the code those notes are about.
 *
 * The division of labour between the two hooks is the part worth reading:
 *
 *   `useActionState` owns the **result** — the pending flag while the save is
 *   in flight, the field errors Zod produced, the sentence for the toast. It is
 *   what a form needs and it is the only one of the two React resets for you.
 *
 *   `useOptimistic` owns the **displayed server state** — the heading and the
 *   Published/Draft pill, which describe the row as it stands rather than what
 *   is in the inputs. That distinction is what makes the rollback visible: on a
 *   rejected save the heading snaps back to the stored title while the textarea
 *   keeps what was typed, so the screen says "this is what is saved, that is
 *   what you tried" instead of silently discarding one of the two.
 *
 * The third thing this component owns is the *version* the draft is based on —
 * `basis` below — and with it the conflict panel. `docs/optimistic-concurrency.md`
 * is the long version of that half; the short one is that a save carries the
 * version it read, a save whose row has moved comes back `conflict` instead of
 * overwriting somebody's work, and everything the panel needs is derived from
 * that result rather than stored.
 */

/** The subset of the row an in-flight mutation claims will be true. */
type OptimisticPatch = Partial<Pick<EditablePost, "title" | "published">>;

/**
 * The newest row this component knows about.
 *
 * There are three sources and they arrive out of order: the `post` prop (the
 * Server Component's read, which catches up only when something invalidates),
 * the row a successful save returned, and a row adopted from a conflict
 * resolution. Picking the highest `version` rather than tracking a "current"
 * in state is what keeps them consistent without an effect to synchronise
 * them — and `Post.version` is monotonic per row, so "highest" is a total
 * order rather than a guess.
 *
 * `post` is first so a tie resolves to the server's own read.
 */
function newest(...rows: readonly (EditablePost | null)[]): EditablePost {
  // The first element is the `post` prop at every call site, so the reduce
  // always has a seed and the non-null assertion below is not one.
  const [first, ...rest] = rows as [EditablePost, ...(EditablePost | null)[]];

  return rest.reduce<EditablePost>(
    (best, row) => (row && row.version > best.version ? row : best),
    first,
  );
}

/** The row's editable half, as the merge compares it. */
function fieldsOf(row: EditablePost): EditableFields {
  return { title: row.title, content: row.content };
}

export function PostEditor({ post }: { post: EditablePost }) {
  const [saveState, saveAction, isSaving] = useActionState(
    updatePostAction,
    null,
  );
  const [isToggling, startToggling] = useTransition();

  /**
   * The row a conflict resolution was applied from, once the author has made
   * one.
   *
   * The only piece of this that has to be state: everything else about a
   * conflict is derivable from the last save's result, but "the author looked
   * at the other version and decided" is an event, and nothing in the props or
   * the result records that it happened.
   */
  const [adopted, setAdopted] = useState<EditablePost | null>(null);

  /**
   * The row as the screen should currently show it: the server's value, with
   * whatever an in-flight mutation has claimed merged over the top.
   *
   * React drops the merged value the moment the transition that applied it
   * ends, and re-reads `post`. That single sentence is the entire rollback
   * story — there is no error branch here that undoes anything, because a
   * failed action leaves `post` exactly as it was and the discard does the
   * work. It is also why a successful mutation *must* invalidate: if `post`
   * has not been refreshed by the time the transition ends, the discard shows
   * the stale row for one frame before the new data lands.
   */
  /** The row the last save wrote, before the prop has caught up. */
  const savedRow =
    saveState?.success && saveState.data.status === "saved"
      ? saveState.data.post
      : null;

  /** The row the last save found instead of the one it expected. */
  const conflictRow =
    saveState?.success && saveState.data.status === "conflict"
      ? saveState.data.current
      : null;

  /**
   * The row the draft is based on: what the next save claims to have read, and
   * what a three-way merge measures both sides against.
   *
   * This is why `expectedVersion` is not simply `post.version`. After a
   * conflict nothing invalidates — no row was written — so the prop stays at
   * the version this editor loaded, and a save built from it would present the
   * same stale token and conflict again forever.
   */
  const basis = newest(post, savedRow, adopted);

  /**
   * The conflict the author still has to deal with, if any.
   *
   * Derived rather than stored, so there is no state to clear and no way for a
   * panel to outlive the result that produced it. Adopting a row is what closes
   * it: the resolution is based on that exact version, so a conflict whose row
   * is no newer than the adopted one has been answered — and one that *is*
   * newer is a third writer, which has to reopen it.
   */
  const conflict =
    conflictRow && (!adopted || adopted.version < conflictRow.version)
      ? conflictRow
      : null;

  const [optimistic, applyOptimistic] = useOptimistic(
    // `basis` rather than `post`: after a resolution the adopted row is the
    // truest thing on screen, and the heading claiming otherwise until the next
    // refresh would contradict the panel that had just described it.
    basis,
    (current, patch: OptimisticPatch) => ({ ...current, ...patch }),
  );

  /**
   * The inputs are controlled, and that is not the default choice it looks
   * like. React resets an uncontrolled `<form action={…}>` once the action
   * resolves — on failure as well as on success — so `defaultValue` here would
   * throw away a rejected draft at precisely the moment its author needs it
   * back.
   *
   * Nothing resyncs this from `post` afterwards, deliberately. The obvious
   * "reset the draft when the row changes" effect keys on something like
   * `updatedAt`, and `updatedAt` moves when the *publish toggle* writes — so
   * hitting Publish would silently wipe unsaved edits. Text someone is in the
   * middle of typing belongs to them until they navigate away.
   */
  const [draft, setDraft] = useState({
    title: post.title,
    content: post.content ?? "",
  });

  const failure = saveState && !saveState.success ? saveState : null;
  const titleError = failure?.fieldErrors?.title?.[0];
  const contentError = failure?.fieldErrors?.content?.[0];
  const isBusy = isSaving || isToggling;

  /**
   * The three-way comparison the panel renders, recomputed on every keystroke
   * while a conflict is open.
   *
   * Cheap — two string comparisons — and correct by construction that way: an
   * author who keeps typing while the panel is up is changing `mine`, and a
   * merge frozen at the moment of the conflict would offer them a choice
   * between the other version and text they have since replaced.
   */
  const merge = conflict
    ? mergeEditable({
        base: fieldsOf(basis),
        mine: draft,
        theirs: fieldsOf(conflict),
      })
    : null;

  /**
   * Only the success half reaches a toast.
   *
   * The auth forms toast their whole-form failures because they have nowhere
   * else to put them — the page is the form. This one does: the failure renders
   * beside the Save button it belongs to, where it stays put and is still there
   * when someone comes back to the tab. Sending it to a toast *as well* would
   * report one rejection twice, in two places, one of which disappears on a
   * timer.
   */
  useEffect(() => {
    if (saveState?.success && saveState.data.status === "saved") {
      toast.success("Post saved");
    }
  }, [saveState]);

  /**
   * Takes the resolved values into the editor and rebases the draft on the row
   * they were reconciled against.
   *
   * Both halves matter. Without the values the author would have to retype
   * their own merge; without the rebase the next save would carry the version
   * this editor originally loaded and be rejected by the same check, for a
   * conflict that has just been resolved.
   *
   * It deliberately does not save. See the note on `ConflictPanel`.
   */
  function handleResolve(values: EditableFields) {
    if (!conflict) return;

    setDraft({ title: values.title, content: values.content ?? "" });
    setAdopted(conflict);
  }

  function handleSubmit(formData: FormData) {
    const title = draft.title.trim();

    // Applied from the draft rather than from `formData`, so the value the
    // heading shows is the one the schema will see — `updatePostSchema` trims
    // the title, and an optimistic heading with the untrimmed string would be
    // replaced by a subtly different one on success.
    //
    // Skipped when the title is empty: that submission is going to fail its
    // schema, and blanking the heading for the length of the round trip
    // communicates nothing that the field error under the input does not.
    if (title !== "") {
      applyOptimistic({ title });
    }

    saveAction(formData);
  }

  function handleTogglePublished() {
    startToggling(async () => {
      // Before the `await`, and this is load-bearing: React only associates an
      // optimistic update with a transition while that transition's scope is
      // on the stack, and in an async transition everything after the first
      // `await` has left it. Applied afterwards, this would be an ordinary
      // state update — one that never rolls back.
      applyOptimistic({ published: !optimistic.published });

      const result = await togglePublishAction(post.id);

      if (!result.success) {
        toast.error(result.error);
        return;
      }

      toast.success(
        result.data.published ? "Post published" : "Post reverted to draft",
      );
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <h2
            className="truncate text-xl font-semibold"
            data-testid="post-heading"
          >
            {optimistic.title}
          </h2>
          <span
            data-testid="publish-state"
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium transition-opacity",
              optimistic.published
                ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
              isBusy && "opacity-60",
            )}
          >
            {optimistic.published ? "Published" : "Draft"}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/posts"
            className="rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--muted)]"
          >
            Back to posts
          </Link>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleTogglePublished}
            disabled={isBusy}
          >
            {optimistic.published ? "Unpublish" : "Publish"}
          </Button>
        </div>
      </div>

      {merge && conflict && (
        <ConflictPanel
          merge={merge}
          theirVersion={conflict.version}
          onResolve={handleResolve}
        />
      )}

      <form action={handleSubmit} className="flex flex-col gap-4">
        {/* The row this form writes. A hidden field rather than a bound
            argument so the whole payload arrives as one `FormData` the schema
            parses in one place — and it is validated like every other field,
            because a hidden input is as forgeable as a visible one. */}
        <input type="hidden" name="postId" value={post.id} />
        {/* The optimistic-concurrency token: the version this draft was made
            from, which the `UPDATE` matches on. Hidden and forgeable like the
            id beside it, and validated by the schema for the same reason — but
            worth being clear about what the check is for. It stops an *honest*
            client from overwriting an edit it never saw; a caller that posts
            the current version on purpose gets what an unconditional save would
            have given everyone, and it is the ownership check, not this, that
            decides who may write the row at all. */}
        <input
          type="hidden"
          name="expectedVersion"
          value={basis.version}
          data-testid="expected-version"
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="post-title" className="text-sm font-medium">
            Title <span className="text-red-500">*</span>
          </label>
          <Input
            id="post-title"
            name="title"
            value={draft.title}
            onChange={(event) =>
              setDraft((current) => ({ ...current, title: event.target.value }))
            }
            maxLength={255}
            required
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? "post-title-error" : undefined}
          />
          {titleError && (
            <p id="post-title-error" className="text-xs text-red-600">
              {titleError}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="post-content" className="text-sm font-medium">
            Content
          </label>
          <textarea
            id="post-content"
            name="content"
            rows={12}
            value={draft.content}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                content: event.target.value,
              }))
            }
            placeholder="Write something…"
            className="flex w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
            aria-invalid={contentError ? true : undefined}
            aria-describedby={contentError ? "post-content-error" : undefined}
          />
          {contentError && (
            <p id="post-content-error" className="text-xs text-red-600">
              {contentError}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={isBusy}>
            {isSaving ? "Saving…" : "Save changes"}
          </Button>
          {/* The whole-form failure, for the rejections that have no field to
              hang on: a post deleted in another tab, an ownership check that
              said no, the fixed sentence a server fault is replaced with. */}
          {failure && !failure.fieldErrors && (
            <p role="alert" className="text-xs text-red-600">
              {failure.error}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
