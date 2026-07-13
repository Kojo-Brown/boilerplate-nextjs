import { http, HttpResponse } from "msw";
import type { SerializedPostSummary } from "@/hooks/use-posts";
import type { CursorPage } from "@/lib/pagination";

export const mockPostSummary: SerializedPostSummary = {
  id: "post-1",
  title: "Hello, MSW",
  published: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  author: { id: "user-1", name: "Alice", email: "alice@example.com" },
};

export const handlers = [
  http.get("/api/posts", () => {
    return HttpResponse.json<SerializedPostSummary[]>([mockPostSummary]);
  }),

  http.get("/api/posts/paginated", ({ request }) => {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    const limit = Number(url.searchParams.get("limit") ?? "10");

    const items = Array.from({ length: Math.min(limit, 1) }, () => mockPostSummary);
    const page: CursorPage<SerializedPostSummary> = {
      items,
      nextCursor: cursor ? null : null,
      hasMore: false,
    };

    return HttpResponse.json(page);
  }),
];
