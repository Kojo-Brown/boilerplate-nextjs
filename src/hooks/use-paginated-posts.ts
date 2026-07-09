"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import type { CursorPage } from "@/lib/pagination";
import type { SerializedPostSummary } from "@/hooks/use-posts";

export const PAGINATED_POSTS_QUERY_KEY = ["posts", "paginated"] as const;

async function fetchPaginatedPosts(
  cursor: string | undefined,
  limit: number,
): Promise<CursorPage<SerializedPostSummary>> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);

  const res = await fetch(`/api/posts/paginated?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch posts");

  return res.json() as Promise<CursorPage<SerializedPostSummary>>;
}

export function usePaginatedPosts(limit = 10) {
  return useInfiniteQuery({
    queryKey: [...PAGINATED_POSTS_QUERY_KEY, limit],
    queryFn: ({ pageParam }) => fetchPaginatedPosts(pageParam, limit),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}
