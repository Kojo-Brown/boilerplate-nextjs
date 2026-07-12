import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuthSession } from "@/lib/session";
import { SessionGuard } from "./session-guard";

vi.mock("@/lib/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/session";

const mockGetSession = vi.mocked(getSession);

const fakeSession: AuthSession = {
  user: {
    id: "user-1",
    role: "USER",
    email: "user@example.com",
    name: "Test User",
    image: null,
  },
  expires: "2099-01-01T00:00:00.000Z",
};

describe("SessionGuard (server component)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders children when a valid session exists", async () => {
    mockGetSession.mockResolvedValue(fakeSession);

    const element = await SessionGuard({
      children: <span>Protected content</span>,
    });

    const html = renderToStaticMarkup(element as React.ReactElement);
    expect(html).toContain("Protected content");
  });

  it("renders fallback when there is no session", async () => {
    mockGetSession.mockResolvedValue(null);

    const element = await SessionGuard({
      children: <span>Protected content</span>,
      fallback: <a href="/login">Sign in</a>,
    });

    const html = renderToStaticMarkup(element as React.ReactElement);
    expect(html).toContain("Sign in");
    expect(html).not.toContain("Protected content");
  });

  it("renders nothing when there is no session and no fallback provided", async () => {
    mockGetSession.mockResolvedValue(null);

    const element = await SessionGuard({
      children: <span>Protected content</span>,
    });

    const html = renderToStaticMarkup(element as React.ReactElement);
    expect(html).toBe("");
  });

  it("renders multiple children when session exists", async () => {
    mockGetSession.mockResolvedValue(fakeSession);

    const element = await SessionGuard({
      children: (
        <>
          <span>Item one</span>
          <span>Item two</span>
        </>
      ),
    });

    const html = renderToStaticMarkup(element as React.ReactElement);
    expect(html).toContain("Item one");
    expect(html).toContain("Item two");
  });
});
