"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createPostAction, deletePostAction, togglePublishAction } from "@/actions/posts";
import type { PostSummary } from "@/lib/dal/posts";

export type SerializedPostSummary = Omit<PostSummary, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

export const POSTS_QUERY_KEY = ["posts"] as const;

async function fetchPosts(): Promise<SerializedPostSummary[]> {
  const res = await fetch("/api/posts");
  if (!res.ok) throw new Error("Failed to fetch posts");
  return res.json() as Promise<SerializedPostSummary[]>;
}

export function usePostsQuery(initialData?: PostSummary[]) {
  const serialized = initialData?.map((p) => ({
    ...p,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));

  return useQuery({
    queryKey: POSTS_QUERY_KEY,
    queryFn: fetchPosts,
    initialData: serialized,
    initialDataUpdatedAt: 0,
  });
}

export function useCreatePost() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { title: string; content?: string }) => {
      const result = await createPostAction(input);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: POSTS_QUERY_KEY });
      const previous = queryClient.getQueryData<SerializedPostSummary[]>(POSTS_QUERY_KEY);

      const optimistic: SerializedPostSummary = {
        id: `optimistic-${Date.now()}`,
        title: input.title,
        published: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        author: { id: "", name: null, email: "" },
      };

      queryClient.setQueryData<SerializedPostSummary[]>(POSTS_QUERY_KEY, (old) => [
        optimistic,
        ...(old ?? []),
      ]);

      return { previous };
    },
    onError: (err, _input, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(POSTS_QUERY_KEY, context.previous);
      }
      toast.error(err instanceof Error ? err.message : "Failed to create post");
    },
    onSuccess: () => {
      toast.success("Post created");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: POSTS_QUERY_KEY });
    },
  });
}

export function useDeletePost() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (postId: string) => {
      const result = await deletePostAction(postId);
      if (!result.success) throw new Error(result.error);
    },
    onMutate: async (postId) => {
      await queryClient.cancelQueries({ queryKey: POSTS_QUERY_KEY });
      const previous = queryClient.getQueryData<SerializedPostSummary[]>(POSTS_QUERY_KEY);

      queryClient.setQueryData<SerializedPostSummary[]>(POSTS_QUERY_KEY, (old) =>
        old?.filter((p) => p.id !== postId) ?? [],
      );

      return { previous };
    },
    onError: (err, _postId, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(POSTS_QUERY_KEY, context.previous);
      }
      toast.error(err instanceof Error ? err.message : "Failed to delete post");
    },
    onSuccess: () => {
      toast.success("Post deleted");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: POSTS_QUERY_KEY });
    },
  });
}

export function useTogglePublish() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (postId: string) => {
      const result = await togglePublishAction(postId);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    onMutate: async (postId) => {
      await queryClient.cancelQueries({ queryKey: POSTS_QUERY_KEY });
      const previous = queryClient.getQueryData<SerializedPostSummary[]>(POSTS_QUERY_KEY);

      queryClient.setQueryData<SerializedPostSummary[]>(POSTS_QUERY_KEY, (old) =>
        old?.map((p) => (p.id === postId ? { ...p, published: !p.published } : p)) ?? [],
      );

      return { previous };
    },
    onError: (err, _postId, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(POSTS_QUERY_KEY, context.previous);
      }
      toast.error(err instanceof Error ? err.message : "Failed to update post");
    },
    onSuccess: (data) => {
      toast.success(data.published ? "Post published" : "Post unpublished");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: POSTS_QUERY_KEY });
    },
  });
}
