import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/session", () => ({
  getRequiredSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@/lib/dal/posts", () => ({
  getPostsByUser: vi.fn(),
}));

// The Server Actions these pages reach transitively import `@/auth`, and
// next-auth's `lib/env.js` does a bare `next/server` import that Vitest's node
// resolver rejects. Neither action is what is under test here.
vi.mock("@/actions/auth", () => ({
  signOutAction: vi.fn(),
  loginAction: vi.fn(),
  registerAction: vi.fn(),
  signInWithGoogleAction: vi.fn(),
}));

vi.mock("@/actions/upload", () => ({
  getPresignedUploadUrlAction: vi.fn(),
}));

// A Client Component with TanStack Query hooks. `<PostsSection>` only has to
// hand it the data it fetched; rendering the real one would need a DOM and a
// QueryClient, neither of which says anything about the session check.
vi.mock("./posts/_components/posts-manager", () => ({
  PostsManager: () => null,
}));

import { authConfig, PROTECTED_PREFIXES } from "@/auth.config";
import { getRequiredSession } from "@/lib/session";
import { getPostsByUser } from "@/lib/dal/posts";
import type { AuthSession } from "@/lib/session";

const mockGetRequiredSession = vi.mocked(getRequiredSession);
const mockGetPostsByUser = vi.mocked(getPostsByUser);

const session = {
  user: { id: "user-1", role: "USER", email: "grace@example.com" },
  expires: "2099-01-01",
} as AuthSession;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRequiredSession.mockResolvedValue(session);
  mockGetPostsByUser.mockResolvedValue([]);
});

type AuthorizedParams = Parameters<
  NonNullable<NonNullable<typeof authConfig.callbacks>["authorized"]>
>[0];

const authorized = authConfig.callbacks!.authorized!;

function anonymousRequestFor(path: string) {
  return {
    auth: null,
    request: {
      nextUrl: new URL(path, "http://localhost:3000"),
    } as AuthorizedParams["request"],
  };
}

/**
 * `/posts`, `/images` and `/upload` used to be protected by an
 * `await getRequiredSession()` at the top of their page components, because the
 * proxy did not list them and `(dashboard)/layout.tsx` had stopped reading the
 * session.
 *
 * That worked and cost all three of them their prerender: under Cache
 * Components a page cannot gate on a cookie and still put anything in the
 * static shell, so their headings — and, on `/images`, twelve kilobytes of
 * literals — were streamed to every visitor on every request.
 *
 * The gate moved to `PROTECTED_PREFIXES`, which is both earlier (no response
 * has begun) and unconditional (it does not depend on a page component
 * remembering to call something). These tests are that gate, named route by
 * route rather than folded into a loop over the constant, so deleting an entry
 * fails a test that says which route just became public.
 */
describe("dashboard routes that render no per-request data", () => {
  it.for(["/posts", "/images", "/upload"] as const)(
    "%s is gated by the proxy, not by rendering",
    (route) => {
      expect(PROTECTED_PREFIXES).toContain(route);

      const result = authorized(anonymousRequestFor(route));

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).headers.get("location")).toContain("/login");
    },
  );

  it.for([
    ["/images", () => import("./images/page")],
    ["/upload", () => import("./upload/page")],
  ] as const)("%s prerenders: no session read, no await", async ([, load]) => {
    const { default: Page } = await load();

    // Synchronous. An async page is an awaited page, and everything it renders
    // would be behind that await again — which is the failure
    // scripts/assert-streaming-boundaries.ts checks for in the built output and
    // this checks for in the source.
    expect(Page.constructor.name).toBe("Function");

    Page();

    expect(mockGetRequiredSession).not.toHaveBeenCalled();
  });
});

/**
 * `/posts` is the other half of the same rule: it *does* render per-request
 * data, so the read stays — it just moved down into the boundary with the
 * markup that needs it.
 */
describe("/posts", () => {
  it("prerenders its heading: the page component is synchronous", async () => {
    const { default: Page } = await import("./posts/page");

    expect(Page.constructor.name).toBe("Function");

    Page();

    expect(mockGetRequiredSession).not.toHaveBeenCalled();
  });

  it("reads the session inside the boundary and scopes the query to it", async () => {
    const { PostsSection } = await import("./posts/_components/posts-section");

    await PostsSection();

    expect(mockGetRequiredSession).toHaveBeenCalled();
    // The check that matters is not that a session was read but that the query
    // was fenced by it. A `getPostsByUser` call with anything else here is one
    // user's dashboard showing another user's drafts.
    expect(mockGetPostsByUser).toHaveBeenCalledWith(session.user.id);
  });

  it("propagates the redirect when there is no session", async () => {
    // getRequiredSession calls redirect(), which throws. The section must not
    // swallow it — catching it here would render one user's posts to whoever
    // reached the route with a stale cookie.
    mockGetRequiredSession.mockRejectedValue(new Error("NEXT_REDIRECT"));

    const { PostsSection } = await import("./posts/_components/posts-section");

    await expect(PostsSection()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockGetPostsByUser).not.toHaveBeenCalled();
  });
});

describe("(dashboard)/layout", () => {
  it("does not read the session, so the chrome can prerender", async () => {
    // The whole point of the restructure. If this starts failing, the static
    // shell for every dashboard route has collapsed to a <title> — and
    // scripts/assert-route-shape.ts will be failing too.
    const { default: DashboardLayout } = await import("./layout");

    DashboardLayout({ children: null });

    expect(mockGetRequiredSession).not.toHaveBeenCalled();
  });

  it("is synchronous", async () => {
    // An async layout is an awaited layout, and the shell would be behind it
    // again — this is the property, stated directly rather than inferred from
    // the session mock not being called.
    const { default: DashboardLayout } = await import("./layout");

    expect(DashboardLayout.constructor.name).toBe("Function");
  });
});
