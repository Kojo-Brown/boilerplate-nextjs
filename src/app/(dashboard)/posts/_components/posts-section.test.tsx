// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@/lib/session", () => ({
  getRequiredSession: vi.fn(),
}));

vi.mock("@/lib/dal/posts", () => ({
  getPostsByUser: vi.fn(),
}));

// The manager is a Client Component driven by TanStack Query. What matters
// here is the data `<PostsSection>` hands it, so it is replaced by something
// that reports its props.
vi.mock("./posts-manager", () => ({
  PostsManager: ({ userId, initialPosts }: PostsManagerProps) => (
    <div
      data-testid="posts-manager"
      data-user-id={userId}
      data-count={initialPosts.length}
    />
  ),
}));

import { getRequiredSession } from "@/lib/session";
import { getPostsByUser } from "@/lib/dal/posts";
import type { AuthSession } from "@/lib/session";
import type { PostSummary } from "@/lib/dal/posts";
import { PostsSection, PostsSectionFallback } from "./posts-section";

type PostsManagerProps = { userId: string; initialPosts: PostSummary[] };

const mockGetRequiredSession = vi.mocked(getRequiredSession);
const mockGetPostsByUser = vi.mocked(getPostsByUser);

function post(id: string): PostSummary {
  return {
    id,
    title: `Post ${id}`,
    published: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    author: { id: "user-1", name: "Grace Hopper", email: "grace@example.com" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRequiredSession.mockResolvedValue({
    user: { id: "user-1", role: "USER", email: "grace@example.com" },
    expires: "2099-01-01",
  } as AuthSession);
  mockGetPostsByUser.mockResolvedValue([post("a"), post("b")]);
});

describe("PostsSection", () => {
  it("counts the posts it actually fetched", async () => {
    const { container } = render(await PostsSection());

    expect(container.textContent).toContain("2 posts in your account");
  });

  it("says 'post', singular, for one", async () => {
    mockGetPostsByUser.mockResolvedValue([post("a")]);

    const { container } = render(await PostsSection());

    expect(container.textContent).toContain("1 post in your account");
    expect(container.textContent).not.toContain("1 posts");
  });

  it("says so plainly when there are none", async () => {
    mockGetPostsByUser.mockResolvedValue([]);

    const { container } = render(await PostsSection());

    expect(container.textContent).toContain("No posts yet");
  });

  it("hands the manager the session's user and the posts it fetched", async () => {
    const { getByTestId } = render(await PostsSection());

    const manager = getByTestId("posts-manager");
    expect(manager).toHaveAttribute("data-user-id", "user-1");
    expect(manager).toHaveAttribute("data-count", "2");
  });
});

describe("PostsSectionFallback", () => {
  it("is shaped like the list it stands in for, not a card grid", async () => {
    // The skeleton this replaced drew six cards in a three-column grid. The
    // page has always rendered a single vertical list, so the layout corrected
    // itself in front of the reader every time the hole filled.
    const { container } = render(<PostsSectionFallback />);

    expect(container.querySelector(".sm\\:grid-cols-3")).toBeNull();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(
      0,
    );
  });

  it("reserves a row for the count line above the list", () => {
    const { container } = render(<PostsSectionFallback />);

    // The first skeleton is the "N posts in your account" line; without it the
    // whole list jumps down a row when the section resolves.
    expect(container.querySelector(".animate-pulse")?.className).toContain(
      "h-5",
    );
  });
});
