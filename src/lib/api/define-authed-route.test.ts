import { describe, it, expect, vi, beforeEach } from "vitest";

// Declared before the imports below, so `@/auth` — and the Prisma graph behind
// it — is never resolved for real in this suite.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { defineAuthedRoute } from "./define-authed-route";

const mockAuth = vi.mocked(auth as () => Promise<Session | null>);

function request(): NextRequest {
  return new NextRequest(new Request("https://example.test/api/posts"));
}

function session(overrides: Partial<Session["user"]> = {}): Session {
  return {
    user: {
      id: "user-1",
      email: "alice@example.com",
      name: "Alice",
      image: null,
      role: "USER" as const,
      ...overrides,
    },
    expires: "2099-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("defineAuthedRoute", () => {
  it("hands the authenticated user to the handler", async () => {
    mockAuth.mockResolvedValue(session());
    const GET = defineAuthedRoute<{ id: string; role: string }>({
      handler: ({ user }) => ({ id: user.id, role: user.role }),
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "user-1",
      role: "USER",
    });
  });

  it("answers 401 when there is no session", async () => {
    mockAuth.mockResolvedValue(null);
    const GET = defineAuthedRoute<string>({ handler: () => "secret" });

    const response = await GET(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "unauthorized", message: "Authentication required" },
    });
  });

  it("answers 401 for a session whose user has no id", async () => {
    // A JWT minted before the `id` callback deserialises to exactly this. Every
    // query in the handler would then filter on `undefined`, which Prisma reads
    // as "no filter" rather than "no rows" — so this is a data leak, not a nit.
    mockAuth.mockResolvedValue(session({ id: undefined as unknown as string }));
    const handler = vi.fn(() => "secret");
    const GET = defineAuthedRoute<string>({ handler });

    expect((await GET(request())).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers 403 — not 401 — when a signed-in user lacks the required role", async () => {
    mockAuth.mockResolvedValue(session({ role: "USER" }));
    const handler = vi.fn(() => "admin things");
    const GET = defineAuthedRoute<string>({ role: "ADMIN", handler });

    const response = await GET(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "forbidden",
        message: "This route requires the ADMIN role",
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("admits a user who has the required role", async () => {
    mockAuth.mockResolvedValue(session({ role: "ADMIN" }));
    const GET = defineAuthedRoute<string>({
      role: "ADMIN",
      handler: () => "admin things",
    });

    expect((await GET(request())).status).toBe(200);
  });

  it("still validates inputs, and does so before reading the session", async () => {
    mockAuth.mockResolvedValue(null);
    const GET = defineAuthedRoute<string>({ handler: () => "x" });

    // The 401 proves the guard ran; `auth()` being called exactly once proves
    // the wrapper is not resolving the session twice per request.
    expect((await GET(request())).status).toBe(401);
    expect(mockAuth).toHaveBeenCalledTimes(1);
  });
});
