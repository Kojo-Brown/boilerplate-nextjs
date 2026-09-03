// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { notFound } from "next/navigation";

vi.mock("@/lib/session", () => ({
  getRequiredSession: vi.fn(),
}));

vi.mock("@/lib/dal/posts", () => ({
  getEditablePost: vi.fn(),
}));

// The editor is a Client Component with two Server Actions behind it. What
// matters here is the row `<EditorSection>` hands it, so it is replaced by
// something that reports its props.
vi.mock("./post-editor", () => ({
  PostEditor: ({ post }: { post: EditablePost }) => (
    <div data-testid="post-editor" data-post-id={post.id} />
  ),
}));

import { getRequiredSession } from "@/lib/session";
import { getEditablePost } from "@/lib/dal/posts";
import type { AuthSession } from "@/lib/session";
import type { EditablePost } from "@/lib/dal/posts";
import { EditorSection, EditorSectionFallback } from "./editor-section";

const mockGetRequiredSession = vi.mocked(getRequiredSession);
const mockGetEditablePost = vi.mocked(getEditablePost);

const post: EditablePost = {
  id: "post-1",
  title: "Original title",
  content: "Original body",
  published: false,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  version: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRequiredSession.mockResolvedValue({
    user: {
      id: "user-1",
      name: "Grace Hopper",
      email: "grace@example.com",
      role: "USER",
      image: null,
    },
    expires: "2099-01-01",
  } as AuthSession);
});

describe("EditorSection", () => {
  it("loads the post for the signed-in author and renders the editor", async () => {
    mockGetEditablePost.mockResolvedValue(post);

    render(await EditorSection({ params: Promise.resolve({ id: "post-1" }) }));

    expect(screen.getByTestId("post-editor")).toHaveAttribute(
      "data-post-id",
      "post-1",
    );
  });

  it("scopes the read to the caller, not just to the id in the URL", async () => {
    mockGetEditablePost.mockResolvedValue(post);

    await EditorSection({ params: Promise.resolve({ id: "post-1" }) });

    // The ownership filter is an argument to the query. If this ever collapses
    // to `getEditablePost(id)`, every author can open every draft by id.
    expect(mockGetEditablePost).toHaveBeenCalledExactlyOnceWith(
      "post-1",
      "user-1",
    );
  });

  it("404s when the post is missing or belongs to somebody else", async () => {
    // One `null` covers both cases by construction — the DAL filters on
    // `authorId`, so a post the caller does not own is indistinguishable here
    // from one that does not exist. That is the intended answer: a 403 would
    // confirm which ids are real.
    mockGetEditablePost.mockResolvedValue(null);

    await EditorSection({ params: Promise.resolve({ id: "someone-elses" }) });

    expect(notFound).toHaveBeenCalled();
  });
});

describe("EditorSectionFallback", () => {
  it("renders placeholder bars rather than nothing", () => {
    const { container } = render(<EditorSectionFallback />);

    // `<Suspense fallback={null}>` prerenders a page that paints and then
    // jumps; every hole in this repository has to render something.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(
      0,
    );
  });

  it("reserves the tall block the content textarea will occupy", () => {
    const { container } = render(<EditorSectionFallback />);

    // The editor is mostly one large textarea. A fallback of uniform short
    // bars would let the page collapse to a fraction of its height and then
    // shove everything below it down when the hole resolves.
    const heights = [
      ...container.querySelectorAll<HTMLElement>(".animate-pulse"),
    ]
      .map((node) => node.className)
      .filter((className) => className.includes("h-64"));
    expect(heights).toHaveLength(1);
  });
});
