import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { server } from "@/test/server";
import { usePostsQuery, POSTS_QUERY_KEY } from "./use-posts";
import { mockPostSummary } from "@/test/handlers";

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("usePostsQuery", () => {
  it("fetches posts from /api/posts on mount", async () => {
    server.use(
      http.get("/api/posts", () => HttpResponse.json([mockPostSummary])),
    );

    const { result } = renderHook(() => usePostsQuery(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].id).toBe("post-1");
    expect(result.current.data?.[0].title).toBe("Hello, MSW");
  });

  it("returns an empty array when /api/posts responds with []", async () => {
    server.use(
      http.get("/api/posts", () => HttpResponse.json([])),
    );

    const { result } = renderHook(() => usePostsQuery(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(0);
  });

  it("enters error state when /api/posts returns 401", async () => {
    server.use(
      http.get("/api/posts", () =>
        HttpResponse.json({ error: "Unauthorized" }, { status: 401 }),
      ),
    );

    const { result } = renderHook(() => usePostsQuery(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect((result.current.error as Error).message).toBe("Failed to fetch posts");
  });

  it("renders initialData synchronously before the background fetch resolves", async () => {
    server.use(
      http.get("/api/posts", async () => {
        await new Promise<void>((r) => setTimeout(r, 50));
        return HttpResponse.json([{ ...mockPostSummary, id: "fresh-post" }]);
      }),
    );

    const initialData = [
      {
        ...mockPostSummary,
        createdAt: new Date(mockPostSummary.createdAt),
        updatedAt: new Date(mockPostSummary.updatedAt),
      },
    ];

    const { result } = renderHook(() => usePostsQuery(initialData), {
      wrapper: makeWrapper(),
    });

    expect(result.current.data?.[0].id).toBe("post-1");

    await waitFor(() => expect(result.current.data?.[0].id).toBe("fresh-post"));
  });

  it("exposes the canonical query key", () => {
    expect(POSTS_QUERY_KEY).toEqual(["posts"]);
  });
});
