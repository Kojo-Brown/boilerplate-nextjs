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

export function CreatePostDialog() {
  const [open, setOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const createPost = useCreatePost();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const title = titleRef.current?.value.trim() ?? "";
    const content = contentRef.current?.value.trim();

    if (!title) return;

    createPost.mutate(
      { title, content: content || undefined },
      {
        onSuccess: (result) => {
          if (result.success) {
            setOpen(false);
            if (titleRef.current) titleRef.current.value = "";
            if (contentRef.current) contentRef.current.value = "";
          }
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
