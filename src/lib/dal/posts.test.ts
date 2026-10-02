import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The tenancy client is the mock, not `@/lib/prisma`.
 *
 * Every read in this module now goes through one of three access worlds — a
 * tenant scope, the unscoped public path, or the preview capability — and
 * which one a read uses is the property tenancy adds. Mocking the Prisma
 * singleton underneath them would leave all three indistinguishable, which is
 * exactly the confusion row-level security exists to remove.
 *
 * `scopeLog` records `<world>:<operation>` per call, so a read that quietly
 * moves between worlds fails a test rather than a customer.
 */
const { postSpies, scopeLog } = vi.hoisted(() => ({
  postSpies: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
  },
  scopeLog: [] as string[],
}));

vi.mock("@/lib/tenancy/client", () => {
  const model = (world: string) =>
    new Proxy(
      {},
      {
        get:
          (_target, operation: string) =>
          (...args: unknown[]) => {
            scopeLog.push(`${world}:${operation}`);
            // The index is an operation name the proxy was just asked for, so
            // the lookup is total in practice; the cast is what tells
            // `noUncheckedIndexedAccess` that, rather than a `?.` that would
            // silently return undefined for a typo in a test.
            const spy = (postSpies as Record<string, ReturnType<typeof vi.fn>>)[
              operation
            ];
            if (!spy) throw new Error(`No spy for post.${operation}`);
            return spy(...args);
          },
      },
    );

  return {
    unscopedPrisma: { post: model("unscoped") },
    tenantClient: (scope: { tenantId: string }) => ({
      post: model(`tenant:${scope.tenantId}`),
    }),
    // The tenant is in the scope label, so `scopeLog` says *which* workspace a
    // preview read opened and not merely that it opened one.
    withPreviewRead: (
      tenantId: string,
      fn: (tx: { post: unknown }) => unknown,
    ) => fn({ post: model(`preview:${tenantId}`) }),
  };
});

import {
  getPublishedPosts,
  getPostsForPreview,
  getPostsByUser,
  getPostForPreview,
  getPostOwnership,
  getPublishedPostById,
  getPostCountByUser,
  getEditablePost,
  getPaginatedPostsByUser,
  getPaginatedPublishedPosts,
  getPostCountsByAuthor,
  getRecentPostsByAuthor,
  getLastEditedPostByAuthor,
} from "./posts";

const mockPost = {
  id: "post-1",
  title: "Hello World",
  published: true,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  author: { id: "user-1", name: "Alice", email: "alice@example.com" },
};

const mockFullPost = {
  ...mockPost,
  content: "Some content",
  authorId: "user-1",
  author: {
    id: "user-1",
    name: "Alice",
    email: "alice@example.com",
    image: null,
  },
};

const TENANT = "tenant-1";

beforeEach(() => {
  vi.clearAllMocks();
  scopeLog.length = 0;
});

describe("getPublishedPosts", () => {
  it("queries published posts ordered by createdAt desc", async () => {
    vi.mocked(postSpies.findMany).mockResolvedValue([mockPost] as never);

    const result = await getPublishedPosts();

    expect(postSpies.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { published: true },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Hello World");
  });

  it("returns an empty array when no published posts exist", async () => {
    vi.mocked(postSpies.findMany).mockResolvedValue([] as never);

    const result = await getPublishedPosts();
    expect(result).toEqual([]);
  });
});

describe("getPostsForPreview", () => {
  it("applies no published filter, which is the whole reason it is separate", async () => {
    vi.mocked(postSpies.findMany).mockResolvedValue([mockPost] as never);

    await getPostsForPreview(TENANT);

    const [args] = vi.mocked(postSpies.findMany).mock.calls[0] ?? [];
    // Not `where: { published: true }`, and not a `where` at all — an omitted
    // filter is the only shape that cannot be half-right.
    expect(args).not.toHaveProperty("where");
    expect(args).toMatchObject({ orderBy: { createdAt: "desc" } });
  });

  it("orders newest first, like the published list it stands in for", async () => {
    vi.mocked(postSpies.findMany).mockResolvedValue([] as never);

    await getPostsForPreview(TENANT);

    expect(postSpies.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } }),
    );
  });

  it("selects the same fields as the published list", async () => {
    // The two feed one component. A field present in one and not the other is
    // a preview that renders differently from the page it is previewing.
    vi.mocked(postSpies.findMany).mockResolvedValue([] as never);

    await getPublishedPosts();
    await getPostsForPreview(TENANT);

    const [published] = vi.mocked(postSpies.findMany).mock.calls[0] ?? [];
    const [preview] = vi.mocked(postSpies.findMany).mock.calls[1] ?? [];
    expect((preview as { select: unknown }).select).toEqual(
      (published as { select: unknown }).select,
    );
  });
});

describe("getPostsByUser", () => {
  it("filters posts by authorId", async () => {
    vi.mocked(postSpies.findMany).mockResolvedValue([mockPost] as never);

    await getPostsByUser(TENANT, "user-1");

    expect(postSpies.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { authorId: "user-1" },
      }),
    );
  });

  it("returns posts for the given user", async () => {
    vi.mocked(postSpies.findMany).mockResolvedValue([mockPost] as never);

    const result = await getPostsByUser(TENANT, "user-1");
    expect(result).toHaveLength(1);
    expect(result[0]?.author.id).toBe("user-1");
  });
});

describe("getPostForPreview", () => {
  // It reads through the request-scoped batch loader, so the statement is a
  // keyed `findMany` rather than a `findUnique`. `loaders.test.ts` covers the
  // batching itself; these two pin the contract callers depend on.
  it("looks up by primary key", async () => {
    vi.mocked(postSpies.findMany).mockResolvedValue([mockFullPost] as never);

    const result = await getPostForPreview(TENANT, "post-1");

    expect(postSpies.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["post-1"] } } }),
    );
    expect(result?.id).toBe("post-1");
  });

  it("returns null when post does not exist", async () => {
    // A key with no row comes back as an absent row, not an error — the
    // loader's `fetch` returns fewer rows than it was asked for.
    vi.mocked(postSpies.findMany).mockResolvedValue([] as never);

    const result = await getPostForPreview(TENANT, "missing");
    expect(result).toBeNull();
  });
});

describe("getPostOwnership", () => {
  it("reads inside the caller's workspace, so another's post is invisible", async () => {
    // The authorisation read behind `createPreviewLinkAction`, and the reason it
    // is not the preview capability: the minter has a session and therefore a
    // workspace, and reading through the scope is what makes "a post in another
    // workspace" indistinguishable from "no such post".
    vi.mocked(postSpies.findUnique).mockResolvedValue({
      id: "post-1",
      authorId: "user-1",
    } as never);

    await getPostOwnership(TENANT, "user-1", "post-1");

    expect(scopeLog).toEqual([`tenant:${TENANT}:findUnique`]);
  });

  it("selects only what the decision needs", async () => {
    vi.mocked(postSpies.findUnique).mockResolvedValue(null as never);

    await getPostOwnership(TENANT, "user-1", "post-1");

    expect(postSpies.findUnique).toHaveBeenCalledWith({
      where: { id: "post-1" },
      select: { id: true, authorId: true },
    });
  });

  it("returns null for a post the scope cannot see", async () => {
    vi.mocked(postSpies.findUnique).mockResolvedValue(null as never);

    expect(await getPostOwnership(TENANT, "user-1", "elsewhere")).toBeNull();
  });
});

describe("getPublishedPostById", () => {
  it("puts the published filter in the query, not in the caller", async () => {
    vi.mocked(postSpies.findFirst).mockResolvedValue(mockFullPost as never);

    await getPublishedPostById("post-1");

    // The regression this function exists for: while the check lived in the
    // page component, `getCachedPost` could write an unpublished post into a
    // cache entry the whole public shares.
    expect(postSpies.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "post-1", published: true } }),
    );
  });

  it("returns null for an unpublished post", async () => {
    // The database applies the filter, so an unpublished row simply does not
    // come back. This pins the contract callers rely on.
    vi.mocked(postSpies.findFirst).mockResolvedValue(null as never);

    expect(await getPublishedPostById("draft-1")).toBeNull();
  });

  it("includes the same author fields as getPostForPreview", async () => {
    // The two feed one page. A narrower author here would render a byline that
    // differs between the preview and the published view. Still worth pinning
    // now that the unfiltered read goes through the batch loader: the loader's
    // `include` and this one are written in different modules, so they can
    // drift without either looking wrong on its own.
    vi.mocked(postSpies.findMany).mockResolvedValue([mockFullPost] as never);
    vi.mocked(postSpies.findFirst).mockResolvedValue(mockFullPost as never);

    await getPostForPreview(TENANT, "post-1");
    await getPublishedPostById("post-1");

    const [unfiltered] = vi.mocked(postSpies.findMany).mock.calls[0] ?? [];
    const [filtered] = vi.mocked(postSpies.findFirst).mock.calls[0] ?? [];
    expect((filtered as { include: unknown }).include).toEqual(
      (unfiltered as { include: unknown }).include,
    );
  });
});

describe("getPostCountByUser", () => {
  it("counts posts for a specific user", async () => {
    vi.mocked(postSpies.count).mockResolvedValue(3);

    const count = await getPostCountByUser(TENANT, "user-1");

    expect(postSpies.count).toHaveBeenCalledWith({
      where: { authorId: "user-1" },
    });
    expect(count).toBe(3);
  });
});

describe("getPaginatedPostsByUser", () => {
  it("fetches take=limit+1 posts for cursor detection", async () => {
    vi.mocked(postSpies.findMany).mockResolvedValue([mockPost] as never);

    await getPaginatedPostsByUser(TENANT, "user-1", { limit: 10 });

    expect(postSpies.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 11, where: { authorId: "user-1" } }),
    );
  });

  it("passes cursor and skip when cursor is provided", async () => {
    vi.mocked(postSpies.findMany).mockResolvedValue([mockPost] as never);

    await getPaginatedPostsByUser(TENANT, "user-1", {
      cursor: "post-1",
      limit: 5,
    });

    expect(postSpies.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: "post-1" }, skip: 1, take: 6 }),
    );
  });

  it("returns hasMore=true and nextCursor when more items exist", async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      ...mockPost,
      id: `post-${i + 1}`,
    }));
    vi.mocked(postSpies.findMany).mockResolvedValue(items as never);

    const page = await getPaginatedPostsByUser(TENANT, "user-1", { limit: 5 });

    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("post-5");
    expect(page.items).toHaveLength(5);
  });

  it("returns hasMore=false when on last page", async () => {
    vi.mocked(postSpies.findMany).mockResolvedValue([mockPost] as never);

    const page = await getPaginatedPostsByUser(TENANT, "user-1", { limit: 10 });

    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

describe("getPaginatedPublishedPosts", () => {
  it("filters by published=true", async () => {
    vi.mocked(postSpies.findMany).mockResolvedValue([mockPost] as never);

    await getPaginatedPublishedPosts({ limit: 10 });

    expect(postSpies.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { published: true } }),
    );
  });

  it("returns paginated results", async () => {
    const items = Array.from({ length: 4 }, (_, i) => ({
      ...mockPost,
      id: `post-${i + 1}`,
    }));
    vi.mocked(postSpies.findMany).mockResolvedValue(items as never);

    const page = await getPaginatedPublishedPosts({ limit: 10 });

    expect(page.items).toHaveLength(4);
    expect(page.hasMore).toBe(false);
  });
});

describe("getEditablePost", () => {
  it("filters on the author in the query, not in the caller", async () => {
    vi.mocked(postSpies.findFirst).mockResolvedValue(mockFullPost as never);

    await getEditablePost(TENANT, "post-1", "user-1");

    // The ownership rule is the `where`. A read that returned the row and left
    // the check to the page is one `||` away from serving another author's
    // draft — the same failure `getPublishedPostById` was written to close.
    expect(postSpies.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "post-1", authorId: "user-1" },
      }),
    );
  });

  it("selects the editable fields and nothing else", async () => {
    vi.mocked(postSpies.findFirst).mockResolvedValue(mockFullPost as never);

    await getEditablePost(TENANT, "post-1", "user-1");

    expect(postSpies.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          title: true,
          content: true,
          published: true,
          updatedAt: true,
          // The optimistic-concurrency token. Pinned here with the rest
          // because a read that quietly stopped selecting it would leave the
          // editor with no version to send, and the save would fail its schema
          // rather than the page failing to load — a long way from the cause.
          version: true,
        },
      }),
    );
  });

  it("returns null when the post is not this user's", async () => {
    vi.mocked(postSpies.findFirst).mockResolvedValue(null);

    await expect(
      getEditablePost(TENANT, "post-1", "user-2"),
    ).resolves.toBeNull();
  });
});

describe("getPostCountsByAuthor", () => {
  const groups = (published: number, drafts: number) =>
    [
      { published: true, _count: { _all: published } },
      { published: false, _count: { _all: drafts } },
    ] as never;

  it("answers all three tiles with one GROUP BY", async () => {
    vi.mocked(postSpies.groupBy).mockResolvedValue(groups(3, 2));

    const counts = await getPostCountsByAuthor(TENANT, "user-1");

    // The regression this replaces: `@stats` ran two COUNT(*)s and
    // `@notifications` a third, for the same author, in the same render.
    expect(postSpies.groupBy).toHaveBeenCalledTimes(1);
    expect(postSpies.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["published"],
        where: { authorId: "user-1" },
      }),
    );
    expect(counts).toEqual({ total: 5, published: 3, drafts: 2 });
  });

  it("reports zeroes for an author with no posts", async () => {
    // Postgres returns no groups at all, not groups of zero.
    vi.mocked(postSpies.groupBy).mockResolvedValue([] as never);

    expect(await getPostCountsByAuthor(TENANT, "user-1")).toEqual({
      total: 0,
      published: 0,
      drafts: 0,
    });
  });

  it("handles an author whose posts are all published", async () => {
    vi.mocked(postSpies.groupBy).mockResolvedValue([
      { published: true, _count: { _all: 4 } },
    ] as never);

    expect(await getPostCountsByAuthor(TENANT, "user-1")).toEqual({
      total: 4,
      published: 4,
      drafts: 0,
    });
  });

  it("handles an author whose posts are all drafts", async () => {
    vi.mocked(postSpies.groupBy).mockResolvedValue([
      { published: false, _count: { _all: 4 } },
    ] as never);

    expect(await getPostCountsByAuthor(TENANT, "user-1")).toEqual({
      total: 4,
      published: 0,
      drafts: 4,
    });
  });
});

describe("getRecentPostsByAuthor", () => {
  it("takes the caller's limit, newest first", async () => {
    vi.mocked(postSpies.findMany).mockResolvedValue([] as never);

    await getRecentPostsByAuthor(TENANT, "user-1", 5);

    expect(postSpies.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { authorId: "user-1" },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
    );
  });

  it("selects only what the activity list renders", async () => {
    vi.mocked(postSpies.findMany).mockResolvedValue([] as never);

    await getRecentPostsByAuthor(TENANT, "user-1", 5);

    const [args] = vi.mocked(postSpies.findMany).mock.calls[0] ?? [];
    expect((args as { select: unknown }).select).toEqual({
      id: true,
      title: true,
      published: true,
      createdAt: true,
    });
  });
});

describe("getLastEditedPostByAuthor", () => {
  it("orders by updatedAt, not createdAt", async () => {
    // The two are different questions. Ordering this one by `createdAt` would
    // make "last worked on" stop moving the moment an old post is edited,
    // which is also why it is a second query rather than the first row of
    // getRecentPostsByAuthor.
    vi.mocked(postSpies.findFirst).mockResolvedValue(null);

    await getLastEditedPostByAuthor(TENANT, "user-1");

    expect(postSpies.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { authorId: "user-1" },
        orderBy: { updatedAt: "desc" },
      }),
    );
  });

  it("returns null for an author with no posts", async () => {
    vi.mocked(postSpies.findFirst).mockResolvedValue(null);

    expect(await getLastEditedPostByAuthor(TENANT, "user-1")).toBeNull();
  });
});

/**
 * Which access world each read runs in.
 *
 * These are the assertions tenancy adds, and they are worth more than they
 * look: every other test in this file passes whether a read is scoped or not,
 * because a mock returns whatever it was told to regardless of which client
 * asked. The bug this catches is a dashboard read quietly moving onto the
 * unscoped client — which in any single-tenant environment, including every
 * developer's laptop, returns exactly the right answer.
 */
describe("access worlds", () => {
  const scopedReads: Array<[string, () => Promise<unknown>]> = [
    ["getPostsByUser", () => getPostsByUser(TENANT, "user-1")],
    ["getPostCountByUser", () => getPostCountByUser(TENANT, "user-1")],
    ["getEditablePost", () => getEditablePost(TENANT, "post-1", "user-1")],
    ["getPostCountsByAuthor", () => getPostCountsByAuthor(TENANT, "user-1")],
    [
      "getRecentPostsByAuthor",
      () => getRecentPostsByAuthor(TENANT, "user-1", 5),
    ],
    [
      "getLastEditedPostByAuthor",
      () => getLastEditedPostByAuthor(TENANT, "user-1"),
    ],
    [
      "getPaginatedPostsByUser",
      () => getPaginatedPostsByUser(TENANT, "user-1", { limit: 10 }),
    ],
  ];

  it.each(scopedReads)(
    "%s reads through the tenant scope",
    async (_name, read) => {
      vi.mocked(postSpies.findMany).mockResolvedValue([] as never);
      vi.mocked(postSpies.findFirst).mockResolvedValue(null as never);
      vi.mocked(postSpies.count).mockResolvedValue(0 as never);
      vi.mocked(postSpies.groupBy).mockResolvedValue([] as never);

      await read();

      expect(scopeLog).toHaveLength(1);
      expect(scopeLog[0]).toMatch(new RegExp(`^tenant:${TENANT}:`));
    },
  );

  it("the dashboard list is scoped to the workspace it was asked for", async () => {
    // Spelled out rather than left to the table above, because this is the
    // property the OWASP checklist cites under A01 and a citation should
    // point at a test whose name says what it establishes.
    vi.mocked(postSpies.findMany).mockResolvedValue([] as never);

    await getPostsByUser("tenant-7", "user-1");

    expect(scopeLog).toEqual(["tenant:tenant-7:findMany"]);
  });

  const publicReads: Array<[string, () => Promise<unknown>]> = [
    ["getPublishedPosts", () => getPublishedPosts()],
    ["getPublishedPostById", () => getPublishedPostById("post-1")],
    [
      "getPaginatedPublishedPosts",
      () => getPaginatedPublishedPosts({ limit: 10 }),
    ],
  ];

  it.each(publicReads)("%s reads unscoped", async (_name, read) => {
    vi.mocked(postSpies.findMany).mockResolvedValue([] as never);
    vi.mocked(postSpies.findFirst).mockResolvedValue(null as never);

    await read();

    expect(scopeLog).toHaveLength(1);
    expect(scopeLog[0]).toMatch(/^unscoped:/);
  });

  it("getPostsForPreview reads through the preview capability", async () => {
    // Not merely "unscoped": an unscoped read cannot see a draft, and the
    // whole reason this function is separate from `getPublishedPosts` is that
    // it must. `posts_preview_read` is the policy that allows it.
    vi.mocked(postSpies.findMany).mockResolvedValue([] as never);

    await getPostsForPreview(TENANT);

    expect(scopeLog).toEqual([`preview:${TENANT}:findMany`]);
  });

  it("getPostForPreview reads through the preview capability, via the loader", async () => {
    vi.mocked(postSpies.findMany).mockResolvedValue([] as never);

    await getPostForPreview(TENANT, "post-1");

    expect(scopeLog).toEqual([`preview:${TENANT}:findMany`]);
  });

  it("opens the preview capability for the workspace it was given", async () => {
    // The parameter is the capability, not a hint about one: `withPreviewRead`
    // writes it into `app.preview_tenant_id`, and `posts_preview_read` matches
    // no row at all without it. A read that passed the wrong workspace here
    // would return nothing rather than someone else's drafts, which is the
    // failure direction this design chose.
    vi.mocked(postSpies.findMany).mockResolvedValue([] as never);

    await getPostsForPreview("tenant-2");

    expect(scopeLog).toEqual(["preview:tenant-2:findMany"]);
  });
});
