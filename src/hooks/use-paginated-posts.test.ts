import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { usePaginatedPosts, PAGINATED_POSTS_QUERY_KEY } from "./use-paginated-posts";
import type { CursorPage } from "@/lib/pagination";
import type { SerializedPostSummary } from "@/hooks/use-posts";

const mockPost: SerializedPostSummary = {
  id: "post-1",
  title: "Hello",
  published: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  author: { id: "user-1", name: "Alice", email: "alice@example.com" },
};

const makePage = (
  items: SerializedPostSummary[],
  nextCursor: string | null = null,
): CursorPage<SerializedPostSummary> => ({
  items,
  nextCursor,
  hasMore: nextCursor !== null,
});

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePaginatedPosts", () => {
  it("fetches the first page on mount", async () => {
    const page = makePage([mockPost]);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(page), { status: 200 }),
    );

    const { result } = renderHook(() => usePaginatedPosts(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.pages[0].items).toHaveLength(1);
    expect(result.current.data?.pages[0].items[0].id).toBe("post-1");
  });

  it("calls the correct URL with limit param", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(makePage([])), { status: 200 }),
    );

    const { result } = renderHook(() => usePaginatedPosts(5), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining("limit=5"),
    );
  });

  it("hasNextPage is true when nextCursor is set", async () => {
    const page = makePage([mockPost], "post-1");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(page), { status: 200 }),
    );

    const { result } = renderHook(() => usePaginatedPosts(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.hasNextPage).toBe(true);
  });

  it("hasNextPage is false when nextCursor is null", async () => {
    const page = makePage([mockPost], null);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(page), { status: 200 }),
    );

    const { result } = renderHook(() => usePaginatedPosts(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.hasNextPage).toBe(false);
  });

  it("throws when the API returns an error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
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
