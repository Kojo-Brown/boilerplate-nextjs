import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/session", () => ({
  getRequiredSession: vi.fn(),
  getSession: vi.fn(),
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

import { getRequiredSession } from "@/lib/session";
import type { AuthSession } from "@/lib/session";

const mockGetRequiredSession = vi.mocked(getRequiredSession);

const session = {
  user: { id: "user-1", role: "USER", email: "grace@example.com" },
  expires: "2099-01-01",
} as AuthSession;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRequiredSession.mockResolvedValue(session);
});

/**
 * `(dashboard)/layout.tsx` used to `await getRequiredSession()`, which gated
 * every route beneath it as a side effect. Making that layout synchronous — so
 * the dashboard chrome could prerender into the PPR shell — removed that gate,
 * and two routes had nothing else protecting them: `/images` and `/upload` are
 * absent from `PROTECTED_PREFIXES` in `auth.config.ts`, so the proxy lets them
 * through.
 *
 * These tests exist so that regression cannot happen quietly. A page here that
 * stops asserting a session is a page anyone on the internet can read.
 *
 * They are also the reason the check belongs on the page rather than the
 * layout: Next does not re-render a shared layout when the user navigates
 * between sibling routes inside it, so a layout-level check is skipped on
 * exactly the navigations an attacker would use.
 */
describe("dashboard routes not covered by the proxy", () => {
  it.for([
    ["/images", () => import("./images/page")],
    ["/upload", () => import("./upload/page")],
  ] as const)("%s requires a session before rendering", async ([, load]) => {
    const { default: Page } = await load();

    await Page();

    expect(mockGetRequiredSession).toHaveBeenCalled();
  });

  it.for([
    ["/images", () => import("./images/page")],
    ["/upload", () => import("./upload/page")],
  ] as const)(
    "%s propagates the redirect when there is no session",
    async ([, load]) => {
      // getRequiredSession calls redirect(), which throws. The page must not
      // swallow it — catching it here would render protected markup to an
      // anonymous visitor.
      const redirect = new Error("NEXT_REDIRECT");
      mockGetRequiredSession.mockRejectedValue(redirect);

      const { default: Page } = await load();

      await expect(Page()).rejects.toThrow("NEXT_REDIRECT");
    },
  );
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
