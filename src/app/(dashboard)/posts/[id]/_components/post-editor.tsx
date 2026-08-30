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
import type { EditablePost } from "@/lib/dal/posts";

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
 */

/** The subset of the row an in-flight mutation claims will be true. */
type OptimisticPatch = Partial<Pick<EditablePost, "title" | "published">>;

export function PostEditor({ post }: { post: EditablePost }) {
  const [saveState, saveAction, isSaving] = useActionState(
    updatePostAction,
    null,
  );
  const [isToggling, startToggling] = useTransition();

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
  const [optimistic, applyOptimistic] = useOptimistic(
    post,
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
    if (saveState?.success) toast.success("Post saved");
  }, [saveState]);

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

      <form action={handleSubmit} className="flex flex-col gap-4">
        {/* The row this form writes. A hidden field rather than a bound
            argument so the whole payload arrives as one `FormData` the schema
            parses in one place — and it is validated like every other field,
            because a hidden input is as forgeable as a visible one. */}
        <input type="hidden" name="postId" value={post.id} />

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
