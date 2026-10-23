"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { useCreatePost } from "@/hooks/use-posts";
import { newIdempotencyKey } from "@/lib/actions/idempotency-key";

/**
 * The client half of `createPostAction`'s idempotency, which is the half with
 * the trap in it.
 *
 * The key identifies *this submission*, not this request, so it is minted once
 * and then held across every attempt at it. Minting one inside `handleSubmit`
 * would compile, read correctly, and protect nothing: the second click of a
 * double-click would arrive carrying a different key and be, as far as the
 * server can tell, a second post someone wanted.
 *
 * So the key lives in a ref, is created on the first submission that needs one,
 * and is cleared only when the post has actually been created. Two consequences
 * follow, and both are the point:
 *
 *   - A failed attempt keeps its key, so the user's retry is deduplicated
 *     against the attempt that may have succeeded on the server before the
 *     connection dropped.
 *   - Editing the title after a failure and submitting again reuses the key for
 *     a different payload, which the server answers with a conflict rather than
 *     with the first attempt's post. That is the correct answer — the two are
 *     genuinely different requests — and `handleSubmit` mints a fresh key when
 *     the form's contents change, so the case a user can actually reach is the
 *     one that works.
 *
 * `disabled={createPost.isPending}` on the submit button stays, and is not a
 * substitute for any of this: it is set in a React commit, and a second click
 * dispatched before that commit lands sees an enabled button. It also does
 * nothing at all for a reload mid-request.
 */
export function CreatePostDialog() {
  const [open, setOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const submissionRef = useRef<{ key: string; payload: string } | null>(null);
  const createPost = useCreatePost();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const title = titleRef.current?.value.trim() ?? "";
    const content = contentRef.current?.value.trim();

    if (!title) return;

    const input = { title, ...(content && { content }) };

    // A key belongs to a payload. Reusing one after the user has changed what
    // they are submitting would trade a duplicate post for a conflict error on
    // a request that is genuinely new, so the payload is compared and a change
    // starts a fresh submission.
    const payload = JSON.stringify(input);
    const previous = submissionRef.current;
    const idempotencyKey =
      previous && previous.payload === payload
        ? previous.key
        : newIdempotencyKey();
    submissionRef.current = { key: idempotencyKey, payload };

    createPost.mutate(
      { idempotencyKey, ...input },
      {
        // `useCreatePost` rejects on a failed action, so reaching onSuccess
        // already means the post was created — there is no result envelope to
        // unwrap here, and errors surface through the hook's onError toast.
        onSuccess: () => {
          submissionRef.current = null;
          setOpen(false);
          if (titleRef.current) titleRef.current.value = "";
          if (contentRef.current) contentRef.current.value = "";
        },
      },
    );
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm">
        New Post
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Post</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="post-title" className="text-sm font-medium">
                Title <span className="text-red-500">*</span>
              </label>
              <Input
                id="post-title"
                ref={titleRef}
                placeholder="My awesome post"
                required
                maxLength={255}
                autoFocus
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="post-content" className="text-sm font-medium">
                Content
              </label>
              <textarea
                id="post-content"
                ref={contentRef}
                placeholder="Write something..."
                rows={4}
                className="flex w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
              />
            </div>

            <DialogFooter>
              <DialogClose
                className="inline-flex h-9 items-center justify-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-[var(--muted)]"
                disabled={createPost.isPending}
              >
                Cancel
              </DialogClose>
              <Button type="submit" disabled={createPost.isPending}>
                {createPost.isPending ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
