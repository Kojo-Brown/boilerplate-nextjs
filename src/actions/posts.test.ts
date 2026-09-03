import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    post: {
      create: vi.fn(),
      findUnique: vi.fn(),
      // `getEditablePost`, which `updatePostAction` re-reads through when its
      // conditional write matches nothing.
      findFirst: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
      // The editor's save: one `UPDATE … WHERE id = ? AND version = ?
      // RETURNING …`, whose empty result *is* the conflict.
      updateManyAndReturn: vi.fn(),
    },
    // `createPostAction` is idempotent, so every call to it claims a key
    // before the handler runs. `beforeEach` stubs these to "the key was free",
    // which is the state every test here except the idempotency ones is about.
    idempotencyKey: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  refresh: vi.fn(),
}));

import type { Session } from "next-auth";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { refresh, updateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { BLOG_POSTS_TAG, blogPostTag } from "@/lib/cache/tags";
import {
  createPostAction,
  deletePostAction,
  togglePublishAction,
  updatePostAction,
} from "./posts";

const mockUpdateTag = vi.mocked(updateTag);

/** The tags dropped by this action call, in order. */
function droppedTags(): string[] {
  return mockUpdateTag.mock.calls.map(([tag]) => tag);
}

// NextAuth v5's `auth` is overloaded (middleware, route wrapper, bare call).
// `vi.mocked` binds to the middleware overload, so narrow it to the no-argument
// form the server actions call before stubbing return values.
const mockAuth = vi.mocked(auth as () => Promise<Session | null>);

const mockSession: Session = {
  user: {
    id: "user-1",
    name: "Alice",
    email: "alice@example.com",
    role: "USER",
  },
  expires: "2099-01-01",
};

const mockPost = {
  id: "post-1",
  title: "Hello World",
  published: false,
  version: 1,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  authorId: "user-1",
  author: { id: "user-1", name: "Alice", email: "alice@example.com" },
};

/**
 * A distinct, schema-valid idempotency key per call.
 *
 * Distinct because two tests sharing a key would, against a real database, be
 * the second one replaying the first — and a fixture that hides that is a
 * fixture that would let the real thing break unnoticed.
 */
let keyCounter = 0;
function newKey(): string {
  keyCounter += 1;
  return `test-idempotency-key-${String(keyCounter).padStart(4, "0")}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(mockSession);

  // The key is free: the claiming insert succeeds, so the handler runs.
  vi.mocked(prisma.idempotencyKey.create).mockResolvedValue({} as never);
  vi.mocked(prisma.idempotencyKey.updateMany).mockResolvedValue({
    count: 1,
  } as never);
  vi.mocked(prisma.idempotencyKey.deleteMany).mockResolvedValue({
    count: 1,
  } as never);
  vi.mocked(prisma.idempotencyKey.findUnique).mockResolvedValue(null as never);
});

describe("createPostAction", () => {
  it("creates a post for the authenticated user", async () => {
    vi.mocked(prisma.post.create).mockResolvedValue(mockPost as never);

    const result = await createPostAction({
      idempotencyKey: newKey(),
      title: "Hello World",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("Hello World");
    }
    expect(prisma.post.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Hello World",
          authorId: "user-1",
        }),
      }),
    );
  });

  it("returns error when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await createPostAction({
      idempotencyKey: newKey(),
      title: "Test",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("signed in");
    }
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  it("returns field errors for empty title", async () => {
    const result = await createPostAction({
      idempotencyKey: newKey(),
      title: "",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fieldErrors).toBeDefined();
    }
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  it("creates a post with optional content", async () => {
    vi.mocked(prisma.post.create).mockResolvedValue({
      ...mockPost,
      content: "Some body",
    } as never);

    const result = await createPostAction({
      idempotencyKey: newKey(),
      title: "Post",
      content: "Some body",
    });

    expect(result.success).toBe(true);
    expect(prisma.post.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ content: "Some body" }),
      }),
    );
  });
});

describe("deletePostAction", () => {
  it("deletes a post owned by the user", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
    } as never);
    vi.mocked(prisma.post.delete).mockResolvedValue(mockPost as never);

    const result = await deletePostAction("post-1");

    expect(result.success).toBe(true);
    expect(prisma.post.delete).toHaveBeenCalledWith({
      where: { id: "post-1" },
    });
  });

  it("returns error when post not found", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(null);

    const result = await deletePostAction("missing");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Post not found.");
    }
    expect(prisma.post.delete).not.toHaveBeenCalled();
  });

  it("returns error when user does not own the post", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-2",
    } as never);

    const result = await deletePostAction("post-1");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("own posts");
    }
    expect(prisma.post.delete).not.toHaveBeenCalled();
  });

  it("returns error when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await deletePostAction("post-1");

    expect(result.success).toBe(false);
    expect(prisma.post.delete).not.toHaveBeenCalled();
  });
});

describe("togglePublishAction", () => {
  it("toggles a draft post to published", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: false,
    } as never);
    vi.mocked(prisma.post.update).mockResolvedValue({
      ...mockPost,
      published: true,
    } as never);

    const result = await togglePublishAction("post-1");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.published).toBe(true);
    }
    expect(prisma.post.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { published: true } }),
    );
  });

  it("toggles a published post to draft", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: true,
    } as never);
    vi.mocked(prisma.post.update).mockResolvedValue({
      ...mockPost,
      published: false,
    } as never);

    const result = await togglePublishAction("post-1");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.published).toBe(false);
    }
  });

  it("returns error when post not found", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(null);

    const result = await togglePublishAction("missing");

    expect(result.success).toBe(false);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it("returns error when user does not own the post", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-2",
      published: false,
    } as never);

    const result = await togglePublishAction("post-1");

    expect(result.success).toBe(false);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });
});

/**
 * The editor's save.
 *
 * A `useActionState` action, so every call here goes through the
 * `(previous, formData)` signature React uses — `formData(...)` below builds
 * the submission rather than an object, because the object form is not a shape
 * this action can ever be called with and testing it would test nothing that
 * ships.
 */
describe("updatePostAction", () => {
  function formData(fields: Record<string, string>): FormData {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.append(key, value);
    return data;
  }

  /** A submission from an editor that loaded version 3 of the post. */
  function submission(fields: Record<string, string>): FormData {
    return formData({ postId: "post-1", expectedVersion: "3", ...fields });
  }

  const existing = { authorId: "user-1", published: false };

  /** The row the conditional write returns when it matches. */
  function written(overrides: Record<string, unknown> = {}) {
    return { ...mockPost, version: 4, ...overrides };
  }

  it("saves a post owned by the user", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.post.updateManyAndReturn).mockResolvedValue([
      written({ title: "Edited", content: "New body" }),
    ] as never);

    const result = await updatePostAction(
      null,
      submission({ title: "Edited", content: "New body" }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("saved");
    }
    expect(prisma.post.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        // The version is part of the write's own `WHERE`, not something read
        // and compared first: a check in a separate statement leaves exactly
        // the window this column exists to close.
        where: { id: "post-1", authorId: "user-1", version: 3 },
        data: {
          title: "Edited",
          content: "New body",
          version: { increment: 1 },
        },
      }),
    );
  });

  it("never writes `published`, so saving a draft cannot publish it", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.post.updateManyAndReturn).mockResolvedValue([
      written(),
    ] as never);

    await updatePostAction(
      null,
      // A caller posting the field anyway is the case that matters: the schema
      // has no `published` key, so it is dropped rather than trusted.
      submission({ title: "Edited", published: "true" }),
    );

    const [call] = vi.mocked(prisma.post.updateManyAndReturn).mock.calls;
    expect(call?.[0].data).not.toHaveProperty("published");
  });

  it("stores an emptied textarea as null rather than an empty string", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.post.updateManyAndReturn).mockResolvedValue([
      written(),
    ] as never);

    await updatePostAction(null, submission({ title: "Edited", content: "" }));

    expect(prisma.post.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ content: null }),
      }),
    );
  });

  it("trims the title, so the saved value matches the optimistic one", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.post.updateManyAndReturn).mockResolvedValue([
      written(),
    ] as never);

    await updatePostAction(null, submission({ title: "  Edited  " }));

    expect(prisma.post.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ title: "Edited" }),
      }),
    );
  });

  it("returns a field error for an empty title", async () => {
    const result = await updatePostAction(null, submission({ title: "   " }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fieldErrors?.title?.[0]).toContain("required");
    }
    expect(prisma.post.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("refuses a submission with no version to check", async () => {
    // Not a formality. A save with no token cannot be conditional, so accepting
    // one would mean any caller can opt out of the concurrency check by leaving
    // a field off — which is the blind overwrite the column exists to prevent.
    const result = await updatePostAction(
      null,
      formData({ postId: "post-1", title: "Edited" }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fieldErrors?.expectedVersion?.[0]).toBeDefined();
    }
    expect(prisma.post.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("refuses a version that is not a whole positive number", async () => {
    const result = await updatePostAction(
      null,
      formData({ postId: "post-1", expectedVersion: "1.5", title: "Edited" }),
    );

    expect(result.success).toBe(false);
    expect(prisma.post.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("refuses to save a post owned by somebody else", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-2",
      published: false,
    } as never);

    const result = await updatePostAction(
      null,
      submission({ title: "Edited" }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("your own posts");
      // A whole-form rejection, not a field one: the editor renders these two
      // in different places, and an ownership failure has no field to blame.
      expect(result.fieldErrors).toBeUndefined();
    }
    expect(prisma.post.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("returns a failure when the post no longer exists", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(null);

    const result = await updatePostAction(
      null,
      submission({ title: "Edited" }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not found");
    }
    expect(prisma.post.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("returns a failure when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await updatePostAction(
      null,
      submission({ title: "Edited" }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("signed in");
    }
    expect(prisma.post.findUnique).not.toHaveBeenCalled();
  });

  it("ignores the previous result it is handed", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.post.updateManyAndReturn).mockResolvedValue([
      written(),
    ] as never);

    // `previous` is whatever React sent back from the client. An action that
    // branched on it would be branching on client-supplied state.
    const result = await updatePostAction(
      { success: false, error: "anything at all" },
      submission({ title: "Edited" }),
    );

    expect(result.success).toBe(true);
  });

  /**
   * The half the version column exists for.
   *
   * Every test here has the conditional write match nothing — which is what
   * Postgres does when the row has moved — and is about what the action makes
   * of that. The distinction it has to draw is three ways: somebody else wrote
   * the row, this same save already wrote it, or the row is gone.
   */
  describe("when the row has moved", () => {
    beforeEach(() => {
      vi.mocked(prisma.post.findUnique).mockResolvedValue(existing as never);
      // Nothing matched `version = 3`.
      vi.mocked(prisma.post.updateManyAndReturn).mockResolvedValue([] as never);
    });

    it("reports a conflict carrying the row as it now stands", async () => {
      const theirs = {
        id: "post-1",
        title: "Their title",
        content: "Their body",
        published: false,
        updatedAt: new Date("2026-01-02"),
        version: 7,
      };
      vi.mocked(prisma.post.findFirst).mockResolvedValue(theirs as never);

      const result = await updatePostAction(
        null,
        submission({ title: "My title", content: "My body" }),
      );

      // A success, not an error: the client cannot merge anything from a
      // sentence, and this outcome has a row attached.
      expect(result.success).toBe(true);
      if (result.success && result.data.status === "conflict") {
        expect(result.data.current).toEqual(theirs);
      } else {
        expect.unreachable("expected a conflict outcome");
      }
      expect(droppedTags()).toEqual([]);
    });

    it("re-reads through the ownership filter, so a conflict cannot leak a row", async () => {
      vi.mocked(prisma.post.findFirst).mockResolvedValue({
        ...mockPost,
        version: 7,
      } as never);

      await updatePostAction(null, submission({ title: "My title" }));

      expect(prisma.post.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "post-1", authorId: "user-1" },
        }),
      );
    });

    it("reports success when the row already says what this save was writing", async () => {
      // The ordinary double-submit: the first attempt landed and moved the
      // version, so the second arrives with a token that is stale because of
      // its own success. A conflict here would offer a choice between two
      // identical documents.
      vi.mocked(prisma.post.findFirst).mockResolvedValue({
        ...mockPost,
        title: "Edited",
        content: "New body",
        version: 4,
      } as never);

      const result = await updatePostAction(
        null,
        submission({ title: "Edited", content: "New body" }),
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("saved");
      }
      // Whichever attempt did the writing already dropped the tags; this one
      // wrote nothing and must not drop them again.
      expect(droppedTags()).toEqual([]);
    });

    it("fails when the row has been deleted rather than edited", async () => {
      vi.mocked(prisma.post.findFirst).mockResolvedValue(null);

      const result = await updatePostAction(
        null,
        submission({ title: "Edited" }),
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not found");
      }
    });
  });
});

/**
 * What each mutation invalidates.
 *
 * These assertions did not exist before, and their absence is why the bug they
 * now cover survived: the suite checked that every action wrote the right row
 * and never that it told the cache. `revalidatePath("/posts")` was mocked, so
 * it was called, and it named a page whose reads are uncached — the public blog
 * kept serving a list without the post that had just been published.
 *
 * The policy itself is tested in `src/lib/cache/invalidation.test.ts`. These
 * cover the part only the action can get wrong: reporting the post's published
 * state accurately, and reporting it at all.
 */
describe("cache invalidation", () => {
  it("does not touch the blog cache when a draft is created", async () => {
    vi.mocked(prisma.post.create).mockResolvedValue(mockPost as never);

    await createPostAction({
      idempotencyKey: newKey(),
      title: "Hello World",
    });

    expect(droppedTags()).toEqual([]);
  });

  it("drops the blog cache when a post is created published", async () => {
    // Posts default to `published: false` today, so this exercises the flag
    // being read from the created row rather than assumed.
    vi.mocked(prisma.post.create).mockResolvedValue({
      ...mockPost,
      published: true,
    } as never);

    await createPostAction({
      idempotencyKey: newKey(),
      title: "Hello World",
    });

    expect(droppedTags()).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
  });

  it("drops the blog cache when a post is published", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: false,
    } as never);
    vi.mocked(prisma.post.update).mockResolvedValue({
      ...mockPost,
      published: true,
    } as never);

    await togglePublishAction("post-1");

    expect(droppedTags()).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
  });

  it("drops the blog cache when a post is unpublished", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: true,
    } as never);
    vi.mocked(prisma.post.update).mockResolvedValue({
      ...mockPost,
      published: false,
    } as never);

    await togglePublishAction("post-1");

    expect(droppedTags()).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
  });

  it("drops the blog cache when a published post is deleted", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: true,
    } as never);
    vi.mocked(prisma.post.delete).mockResolvedValue(mockPost as never);

    await deletePostAction("post-1");

    // The page outlived the row before this: `/blog/[slug]` kept serving a
    // deleted post until its 300-second window expired.
    expect(droppedTags()).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
  });

  it("reads the published flag before deleting, not after", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: true,
    } as never);
    vi.mocked(prisma.post.delete).mockResolvedValue(mockPost as never);

    await deletePostAction("post-1");

    // The row is gone once `delete` returns, so the ownership lookup is the
    // only chance to learn whether the post was public. If that select ever
    // loses `published`, the delete silently stops invalidating anything.
    expect(prisma.post.findUnique).toHaveBeenCalledWith({
      where: { id: "post-1" },
      select: { authorId: true, published: true },
    });
  });

  it("does not touch the blog cache when a draft is deleted", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: false,
    } as never);
    vi.mocked(prisma.post.delete).mockResolvedValue(mockPost as never);

    await deletePostAction("post-1");

    expect(droppedTags()).toEqual([]);
  });

  it("drops the blog cache when a published post is edited", async () => {
    const data = new FormData();
    data.append("postId", "post-1");
    data.append("expectedVersion", "1");
    data.append("title", "Edited");

    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: true,
    } as never);
    vi.mocked(prisma.post.updateManyAndReturn).mockResolvedValue([
      { ...mockPost, published: true, title: "Edited", version: 2 },
    ] as never);

    await updatePostAction(null, data);

    // The title is what `/blog` lists and `/blog/[slug]` renders, so an edit to
    // a live post is as stale-making as publishing one.
    expect(droppedTags()).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
  });

  it("does not touch the blog cache when a draft is edited", async () => {
    const data = new FormData();
    data.append("postId", "post-1");
    data.append("expectedVersion", "1");
    data.append("title", "Edited");

    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: false,
    } as never);
    vi.mocked(prisma.post.updateManyAndReturn).mockResolvedValue([
      { ...mockPost, title: "Edited", version: 2 },
    ] as never);

    await updatePostAction(null, data);

    // Nothing public depends on a draft — but the editor is still holding the
    // old row, so `invalidate` must fall through to `refresh()` rather than
    // doing nothing at all. Without that the optimistic title is discarded
    // back onto stale data the moment the save resolves.
    expect(droppedTags()).toEqual([]);
    expect(refresh).toHaveBeenCalled();
  });

  it("invalidates nothing when a mutation is rejected", async () => {
    // A rejected write must not purge a warm cache entry — otherwise an
    // unauthenticated caller can empty the blog cache on demand by looping a
    // delete they have no permission to perform.
    mockAuth.mockResolvedValue(null);

    await createPostAction({
      idempotencyKey: newKey(),
      title: "Hello",
    });
    await deletePostAction("post-1");
    await togglePublishAction("post-1");

    mockAuth.mockResolvedValue(mockSession);
    vi.mocked(prisma.post.findUnique).mockResolvedValue(null);

    await deletePostAction("missing");
    await togglePublishAction("missing");

    expect(mockUpdateTag).not.toHaveBeenCalled();
  });
});

/**
 * `createPostAction`'s idempotency, end to end through `defineAuthedAction`.
 *
 * The unit tests in `src/lib/actions/idempotency.test.ts` cover the protocol
 * and `idempotency-store.test.ts` covers the statements it issues. What is left
 * — and what those two cannot see — is the wiring: that this action declares a
 * plan at all, that the fingerprint is taken of its parsed input, and that its
 * `output` schema puts back the `Date`s a `Json` column loses. That last one is
 * asserted by comparing a replay against the fresh result rather than by
 * describing it, because the failure mode is a value that looks right in a
 * console and throws in a component.
 *
 * These run against a stand-in for the key table rather than the flat mocks
 * above: a replay is by definition the *second* call, so a stub that answers
 * every call identically cannot express one.
 */
describe("createPostAction idempotency", () => {
  interface KeyRow {
    scope: string;
    action: string;
    key: string;
    fingerprint: string;
    claimToken: string;
    status: "IN_PROGRESS" | "COMPLETED";
    result: unknown;
    expiresAt: Date;
  }

  interface RowSelector {
    scope: string;
    action: string;
    key: string;
    claimToken?: string;
    status?: KeyRow["status"];
    expiresAt?: { lt: Date };
  }

  const rows = new Map<string, KeyRow>();
  const rowId = (where: {
    scope: string;
    action: string;
    key: string;
  }): string => `${where.scope}|${where.action}|${where.key}`;

  /** Whether a row satisfies every condition a `where` actually named. */
  function matches(row: KeyRow, where: RowSelector): boolean {
    if (where.claimToken !== undefined && row.claimToken !== where.claimToken) {
      return false;
    }
    if (where.status !== undefined && row.status !== where.status) return false;
    if (
      where.expiresAt !== undefined &&
      row.expiresAt.getTime() >= where.expiresAt.lt.getTime()
    ) {
      return false;
    }
    return true;
  }

  /**
   * What `postSummarySelect` actually returns — no `authorId`.
   *
   * `mockPost` above carries one, and using it here failed this suite's first
   * run for a reason worth keeping: a replayed result is parsed through the
   * action's `output` schema, and Zod drops what that schema does not declare.
   * So a fixture with a field the real `select` never returns makes the fresh
   * and replayed results differ in the test and agree in production, which is
   * the wrong way round for a fixture to be wrong.
   */
  const createdPost = {
    id: mockPost.id,
    title: mockPost.title,
    published: mockPost.published,
    createdAt: mockPost.createdAt,
    updatedAt: mockPost.updatedAt,
    author: mockPost.author,
  };

  beforeEach(() => {
    rows.clear();

    // The unique index on (scope, action, key) is the whole mechanism, so the
    // stand-in enforces it the way Postgres does: the insert fails.
    vi.mocked(prisma.idempotencyKey.create).mockImplementation(((args: {
      data: KeyRow;
    }) => {
      const id = rowId(args.data);
      if (rows.has(id)) {
        return Promise.reject(
          new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "7.9.1",
          }),
        );
      }
      rows.set(id, { ...args.data, result: null });
      return Promise.resolve(args.data);
    }) as never);

    vi.mocked(prisma.idempotencyKey.updateMany).mockImplementation(((args: {
      where: RowSelector;
      data: Partial<KeyRow>;
    }) => {
      const row = rows.get(rowId(args.where));
      if (!row || !matches(row, args.where)) {
        return Promise.resolve({ count: 0 });
      }

      Object.assign(row, args.data);
      // Prisma's sentinel for SQL NULL is not a value the row should carry.
      if (args.data.result === Prisma.DbNull) row.result = null;
      return Promise.resolve({ count: 1 });
    }) as never);

    vi.mocked(prisma.idempotencyKey.findUnique).mockImplementation(((args: {
      where: {
        scope_action_key: { scope: string; action: string; key: string };
      };
    }) =>
      Promise.resolve(
        rows.get(rowId(args.where.scope_action_key)) ?? null,
      )) as never);

    vi.mocked(prisma.idempotencyKey.deleteMany).mockImplementation(((args: {
      where: RowSelector;
    }) => {
      const id = rowId(args.where);
      const row = rows.get(id);
      if (!row || !matches(row, args.where)) {
        return Promise.resolve({ count: 0 });
      }
      rows.delete(id);
      return Promise.resolve({ count: 1 });
    }) as never);

    vi.mocked(prisma.post.create).mockResolvedValue(createdPost as never);
  });

  it("writes one post for a resubmitted key and answers both alike", async () => {
    const idempotencyKey = newKey();

    const first = await createPostAction({
      idempotencyKey,
      title: "Hello World",
    });
    const second = await createPostAction({
      idempotencyKey,
      title: "Hello World",
    });

    expect(prisma.post.create).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("gives a replayed result the same Date fields as a fresh one", async () => {
    // The whole reason `createPostAction` declares an `output` schema. Without
    // it `createdAt` comes back out of the Json column as a string, and only
    // on the second submission — the hardest place to notice a type error.
    const idempotencyKey = newKey();

    await createPostAction({ idempotencyKey, title: "Hello World" });
    const replayed = await createPostAction({
      idempotencyKey,
      title: "Hello World",
    });

    expect(replayed.success).toBe(true);
    if (replayed.success) {
      expect(replayed.data.createdAt).toBeInstanceOf(Date);
      expect(replayed.data.createdAt).toEqual(mockPost.createdAt);
    }
  });

  it("does not invalidate the cache a second time on a replay", async () => {
    // A replay changed nothing, so dropping a warm blog entry for it would be
    // a purge anyone can trigger by resubmitting.
    vi.mocked(prisma.post.create).mockResolvedValue({
      ...createdPost,
      published: true,
    } as never);
    const idempotencyKey = newKey();

    await createPostAction({ idempotencyKey, title: "Hello World" });
    const dropped = droppedTags().length;
    await createPostAction({ idempotencyKey, title: "Hello World" });

    expect(droppedTags()).toHaveLength(dropped);
  });

  it("refuses a key reused for a different post", async () => {
    const idempotencyKey = newKey();

    await createPostAction({ idempotencyKey, title: "Hello World" });
    const result = await createPostAction({
      idempotencyKey,
      title: "A different post entirely",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("repeat of a different request");
    }
    expect(prisma.post.create).toHaveBeenCalledTimes(1);
  });

  it("scopes a key to its author, so two users may use the same one", async () => {
    const idempotencyKey = newKey();

    await createPostAction({ idempotencyKey, title: "Hello World" });

    mockAuth.mockResolvedValue({
      ...mockSession,
      user: { ...mockSession.user, id: "user-2" },
    });
    const second = await createPostAction({
      idempotencyKey,
      title: "Hello World",
    });

    expect(second.success).toBe(true);
    expect(prisma.post.create).toHaveBeenCalledTimes(2);
  });

  it("lets a retry through after the first attempt failed", async () => {
    // The failure path releases the key. A retry that could never execute is a
    // worse outcome than a duplicate: the user is stuck.
    //
    // The factory logs the original error before replacing it with the generic
    // sentence, which is correct and is noise here.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.post.create)
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(createdPost as never);
    const idempotencyKey = newKey();

    const failed = await createPostAction({
      idempotencyKey,
      title: "Hello World",
    });
    const retried = await createPostAction({
      idempotencyKey,
      title: "Hello World",
    });

    expect(failed.success).toBe(false);
    expect(retried.success).toBe(true);
    expect(prisma.post.create).toHaveBeenCalledTimes(2);
  });

  it("holds the second of two overlapping submissions rather than writing twice", async () => {
    let release: (() => void) | undefined;
    vi.mocked(prisma.post.create).mockImplementation(
      (() =>
        new Promise((resolve) => {
          release = () => resolve(createdPost);
        })) as never,
    );

    const idempotencyKey = newKey();
    const first = createPostAction({ idempotencyKey, title: "Hello World" });

    // Let the first call reach `prisma.post.create` before the second starts,
    // which is exactly the window a double-click lands in.
    await vi.waitFor(() => expect(release).toBeDefined());
    const second = await createPostAction({
      idempotencyKey,
      title: "Hello World",
    });

    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.error).toContain("already being processed");
    }

    release?.();
    await expect(first).resolves.toMatchObject({ success: true });
    expect(prisma.post.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing or too-short key before anything is written", async () => {
    const missing = await createPostAction({
      title: "Hello World",
    } as unknown as Parameters<typeof createPostAction>[0]);
    const tooShort = await createPostAction({
      idempotencyKey: "short",
      title: "Hello World",
    });

    expect(missing.success).toBe(false);
    expect(tooShort.success).toBe(false);
    expect(prisma.post.create).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });
});
