import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/dal/posts", () => ({ getPostOwnership: vi.fn() }));
vi.mock("@/lib/tenancy/active", () => ({ getRequiredTenant: vi.fn() }));

import { redirect } from "next/navigation";
import { cookies, draftMode } from "next/headers";
import { PREVIEW_SCOPE_COOKIE } from "@/lib/preview/scope";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { getPostOwnership } from "@/lib/dal/posts";
import { getRequiredTenant } from "@/lib/tenancy/active";
import { verifyPreviewToken } from "@/lib/preview/token";
import { setRequestHeaders } from "@/test/request-headers";
import { ORIGIN_REJECTED_MESSAGE } from "@/lib/actions/origin";
import { createPreviewLinkAction, exitPreviewAction } from "./preview";

/**
 * The authorisation half of the preview flow.
 *
 * `/api/preview` checks a signature and nothing about who is holding it, by
 * design — a preview link has to be forwardable to a CMS. That makes this
 * action the only place a caller's identity is ever consulted, so its guard is
 * not a formality: an anonymous caller getting a link here is an anonymous
 * caller reading anyone's drafts.
 *
 * The token is verified for real rather than mocked, so a link that comes back
 * from a passing test is a link that would actually be redeemed.
 */
// NextAuth v5's `auth` is overloaded (middleware, route wrapper, bare call).
// Narrowing to the no-argument form is what makes the stub types work.
const mockAuth = vi.mocked(auth as () => Promise<Session | null>);
const mockGetPostOwnership = vi.mocked(getPostOwnership);
const mockGetRequiredTenant = vi.mocked(getRequiredTenant);
const mockRedirect = vi.mocked(redirect);
const mockDraftMode = vi.mocked(draftMode);

const AUTHOR = "user-author";
const TENANT = "tenant-mock-a";

function session(userId: string, role: "USER" | "ADMIN" = "USER") {
  mockAuth.mockResolvedValue({
    user: { id: userId, role },
    expires: "2099-01-01T00:00:00.000Z",
  } as unknown as Session);
}

function post(authorId: string, id = "post-1") {
  mockGetPostOwnership.mockResolvedValue({ id, authorId });
}

/** The workspace the caller is acting in, resolved from a cookie and a membership. */
function tenant(tenantId = TENANT) {
  mockGetRequiredTenant.mockResolvedValue({
    tenantId,
    slug: `${tenantId}-slug`,
    name: "A workspace",
    role: "OWNER",
    scope: { tenantId, userId: AUTHOR },
  } as unknown as Awaited<ReturnType<typeof getRequiredTenant>>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(null);
  mockGetPostOwnership.mockResolvedValue(null);
  tenant();
});

describe("createPreviewLinkAction", () => {
  it("mints a link the redemption route would accept", async () => {
    session(AUTHOR);
    post(AUTHOR);

    const result = await createPreviewLinkAction("post-1");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const token = new URL(result.data.url).searchParams.get("token");
    const verification = await verifyPreviewToken(token as string);

    expect(verification).toEqual({
      valid: true,
      payload: {
        path: "/blog/post-1",
        tenantId: TENANT,
        exp: expect.any(Number),
        nonce: expect.any(String),
      },
    });
  });

  it("reports an expiry the UI can show", async () => {
    session(AUTHOR);
    post(AUTHOR);

    const result = await createPreviewLinkAction("post-1");
    expect(result.success).toBe(true);
    if (!result.success) return;

    // ISO 8601, because a `Date` does not survive the action boundary.
    expect(Number.isNaN(Date.parse(result.data.expiresAt))).toBe(false);
    expect(Date.parse(result.data.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("refuses an anonymous caller", async () => {
    post(AUTHOR);

    const result = await createPreviewLinkAction("post-1");

    expect(result).toEqual({
      success: false,
      error: "You must be signed in to create a preview link.",
    });
    // Nothing was even looked up: an unauthenticated caller must not be able to
    // use this endpoint to probe which post ids exist.
    expect(mockGetPostOwnership).not.toHaveBeenCalled();
  });

  it("refuses a signed-in caller who does not own the post", async () => {
    session("user-someone-else");
    post(AUTHOR);

    const result = await createPreviewLinkAction("post-1");

    expect(result).toEqual({
      success: false,
      error: "That post does not exist, or you cannot preview it.",
    });
  });

  it("lets an ADMIN preview someone else's post", async () => {
    session("user-admin", "ADMIN");
    post(AUTHOR);

    const result = await createPreviewLinkAction("post-1");

    expect(result.success).toBe(true);
  });

  it("answers identically for a missing post and a forbidden one", async () => {
    session("user-someone-else");
    post(AUTHOR);
    const forbidden = await createPreviewLinkAction("post-1");

    session("user-someone-else");
    mockGetPostOwnership.mockResolvedValue(null);
    const missing = await createPreviewLinkAction("post-1");

    // Distinguishing them would turn this action into an oracle for which post
    // ids are real.
    expect(missing).toEqual(forbidden);
  });

  it("rejects an empty post id before touching the database", async () => {
    session(AUTHOR);

    const result = await createPreviewLinkAction("");

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("A post id is required.");
    expect(mockGetPostOwnership).not.toHaveBeenCalled();
  });

  it("reads the post through the workspace the caller is acting in", async () => {
    // The authorisation read and the scoping are the same read, which is what
    // makes it impossible for the post checked and the tenant signed to disagree.
    session(AUTHOR);
    tenant("tenant-mock-b");
    post(AUTHOR);

    await createPreviewLinkAction("post-1");

    expect(mockGetPostOwnership).toHaveBeenCalledExactlyOnceWith(
      "tenant-mock-b",
      AUTHOR,
      "post-1",
    );
  });

  it("signs the workspace it resolved, not one the caller named", async () => {
    // There is no input for a tenant and there must never be: a caller-supplied
    // workspace would be a request for a capability, answered by the thing whose
    // job is to decide whether they may have one.
    session(AUTHOR);
    tenant("tenant-mock-b");
    post(AUTHOR);

    const result = await createPreviewLinkAction("post-1");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const token = new URL(result.data.url).searchParams.get("token");
    const verification = await verifyPreviewToken(token as string);
    expect(verification.valid && verification.payload.tenantId).toBe(
      "tenant-mock-b",
    );
  });

  it("answers not-found for a post in another workspace", async () => {
    // Indistinguishable from an id that was never real, because the scoped read
    // cannot see the row: a member of two workspaces acting in A cannot mint a
    // link for their own post in B, which would name two workspaces at once.
    session(AUTHOR);
    mockGetPostOwnership.mockResolvedValue(null);

    const result = await createPreviewLinkAction("post-in-other-workspace");

    expect(result).toEqual({
      success: false,
      error: "That post does not exist, or you cannot preview it.",
    });
  });

  it("refuses a request posted from another origin", async () => {
    // The one leg that runs before everything else: a signed-in session and a
    // perfectly good post id do not save a request the browser sent from
    // somewhere else.
    session(AUTHOR);
    post(AUTHOR);
    setRequestHeaders({
      origin: "https://evil.example",
      host: "localhost:3000",
    });

    const result = await createPreviewLinkAction("post-1");

    expect(result).toEqual({
      success: false,
      error: ORIGIN_REJECTED_MESSAGE,
    });
    expect(mockGetPostOwnership).not.toHaveBeenCalled();
  });

  it("builds the path from the stored id, not from the caller's string", async () => {
    // The caller's argument reaches Prisma as a lookup key and nothing else.
    // If a traversal-shaped id ever came back from the database the signer
    // would reject it; what this pins down is that the *caller* cannot get one
    // into the path by supplying it.
    session(AUTHOR);
    post(AUTHOR, "post-1");

    const result = await createPreviewLinkAction("../../etc/passwd");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const token = new URL(result.data.url).searchParams.get("token");
    const verification = await verifyPreviewToken(token as string);
    expect(verification.valid && verification.payload.path).toBe(
      "/blog/post-1",
    );
  });
});

describe("exitPreviewAction", () => {
  function form(returnTo?: string): FormData {
    const data = new FormData();
    if (returnTo !== undefined) data.set("returnTo", returnTo);
    return data;
  }

  it("disables draft mode and returns to the page the reader was on", async () => {
    const disable = vi.fn();
    mockDraftMode.mockResolvedValue({
      isEnabled: true,
      enable: vi.fn(),
      disable,
    } as unknown as Awaited<ReturnType<typeof draftMode>>);

    await exitPreviewAction(form("/blog/post-1"));

    expect(disable).toHaveBeenCalledOnce();
    expect(mockRedirect).toHaveBeenCalledExactlyOnceWith("/blog/post-1");
  });

  it("clears the scope cookie as well as the session", async () => {
    // The banner's exit button and `DELETE /api/preview` have to leave the same
    // state behind; leaving the scope would mean a stale capability in the jar.
    // By name *and* path, because that is how a browser matches a deletion.
    const jar = { delete: vi.fn() };
    vi.mocked(cookies).mockResolvedValue(
      jar as unknown as Awaited<ReturnType<typeof cookies>>,
    );
    mockDraftMode.mockResolvedValue({
      isEnabled: true,
      enable: vi.fn(),
      disable: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof draftMode>>);

    await exitPreviewAction(form("/blog/post-1"));

    expect(jar.delete).toHaveBeenCalledExactlyOnceWith({
      name: PREVIEW_SCOPE_COOKIE,
      path: "/",
    });
  });

  it("falls back to /blog when given nowhere to go", async () => {
    await exitPreviewAction(form());

    expect(mockRedirect).toHaveBeenCalledExactlyOnceWith("/blog");
  });

  it("never redirects off-origin, whatever the form said", async () => {
    // `returnTo` arrives in a form post, so it is attacker-controlled like any
    // other field — and this action is reachable unauthenticated by design.
    for (const hostile of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example/blog",
      "javascript:alert(1)",
    ]) {
      mockRedirect.mockClear();
      await exitPreviewAction(form(hostile));
      expect(mockRedirect, hostile).toHaveBeenCalledExactlyOnceWith("/blog");
    }
  });

  it("still leaves draft mode when the destination is rejected", async () => {
    const disable = vi.fn();
    mockDraftMode.mockResolvedValue({
      isEnabled: true,
      enable: vi.fn(),
      disable,
    } as unknown as Awaited<ReturnType<typeof draftMode>>);

    await exitPreviewAction(form("https://evil.example"));

    // Getting out of draft mode is the point of the control; a bad `returnTo`
    // must not be able to keep someone in it.
    expect(disable).toHaveBeenCalledOnce();
  });

  it("refuses a cross-origin post, and stays in draft mode", async () => {
    const disable = vi.fn();
    mockDraftMode.mockResolvedValue({
      isEnabled: true,
      enable: vi.fn(),
      disable,
    } as unknown as Awaited<ReturnType<typeof draftMode>>);
    setRequestHeaders({
      origin: "https://evil.example",
      host: "localhost:3000",
    });

    // A navigation action has no result channel, so the refusal is a throw —
    // which reaches the segment's `error.tsx`.
    await expect(exitPreviewAction(form("/blog"))).rejects.toThrow(
      ORIGIN_REJECTED_MESSAGE,
    );
    expect(disable).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
