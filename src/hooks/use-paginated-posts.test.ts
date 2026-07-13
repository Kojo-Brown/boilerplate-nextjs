import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { server } from "@/test/server";
import { usePaginatedPosts, PAGINATED_POSTS_QUERY_KEY } from "./use-paginated-posts";
import { mockPostSummary } from "@/test/handlers";
import type { CursorPage } from "@/lib/pagination";
import type { SerializedPostSummary } from "@/hooks/use-posts";

function makePage(
  items: SerializedPostSummary[],
  nextCursor: string | null = null,
): CursorPage<SerializedPostSummary> {
  return { items, nextCursor, hasMore: nextCursor !== null };
}

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("usePaginatedPosts", () => {
  it("fetches the first page on mount", async () => {
    server.use(
      http.get("/api/posts/paginated", () =>
        HttpResponse.json(makePage([mockPostSummary])),
      ),
    );

    const { result } = renderHook(() => usePaginatedPosts(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.pages[0].items).toHaveLength(1);
    expect(result.current.data?.pages[0].items[0].id).toBe("post-1");
  });

  it("calls the correct URL with limit param", async () => {
    let capturedUrl: string | undefined;

    server.use(
      http.get("/api/posts/paginated", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(makePage([]));
      }),
    );

    const { result } = renderHook(() => usePaginatedPosts(5), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(capturedUrl).toContain("limit=5");
  });

  it("hasNextPage is true when nextCursor is set", async () => {
    server.use(
      http.get("/api/posts/paginated", () =>
        HttpResponse.json(makePage([mockPostSummary], "cursor-abc")),
      ),
    );

    const { result } = renderHook(() => usePaginatedPosts(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.hasNextPage).toBe(true);
  });

  it("hasNextPage is false when nextCursor is null", async () => {
    server.use(
      http.get("/api/posts/paginated", () =>
        HttpResponse.json(makePage([mockPostSummary], null)),
      ),
    );

    const { result } = renderHook(() => usePaginatedPosts(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.hasNextPage).toBe(false);
  });

  it("enters error state when the API returns 401", async () => {
    server.use(
      http.get("/api/posts/paginated", () =>
        HttpResponse.json({ error: "Unauthorized" }, { status: 401 }),
      ),
    );

    const { result } = renderHook(() => usePaginatedPosts(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
    expect((result.current.error as Error).message).toBe("Failed to fetch posts");
  });

  it("exposes correct query key structure", () => {
    expect(PAGINATED_POSTS_QUERY_KEY).toEqual(["posts", "paginated"]);
  });
});
