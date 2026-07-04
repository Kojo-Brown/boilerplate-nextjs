import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be declared before any imports that trigger module resolution.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getSession, getRequiredSession, getCurrentUser } from "@/lib/session";

const mockAuth = auth as ReturnType<typeof vi.fn>;
const mockRedirect = redirect as ReturnType<typeof vi.fn>;

const fakeSession = {
  user: {
    id: "user-1",
    email: "test@example.com",
    name: "Test User",
    image: null,
    role: "USER" as const,
  },
  expires: "2099-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getSession", () => {
  it("returns null when auth() returns null", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(getSession()).resolves.toBeNull();
  });

  it("returns the session when auth() returns one", async () => {
    mockAuth.mockResolvedValue(fakeSession);
    await expect(getSession()).resolves.toEqual(fakeSession);
  });
});

describe("getRequiredSession", () => {
  it("calls redirect('/login') when there is no session", async () => {
    mockAuth.mockResolvedValue(null);
    mockRedirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(getRequiredSession()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("/login");
  });

  it("returns the session without redirecting when a session exists", async () => {
    mockAuth.mockResolvedValue(fakeSession);
    const session = await getRequiredSession();
    expect(session).toEqual(fakeSession);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("returns a session with correct user shape", async () => {
    mockAuth.mockResolvedValue(fakeSession);
    const session = await getRequiredSession();
    expect(session.user.id).toBe("user-1");
    expect(session.user.role).toBe("USER");
  });
});

describe("getCurrentUser", () => {
  it("returns null when there is no session", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("returns the user object when a session exists", async () => {
    mockAuth.mockResolvedValue(fakeSession);
    const user = await getCurrentUser();
    expect(user).toEqual(fakeSession.user);
  });

  it("returns a user with id and role fields", async () => {
    mockAuth.mockResolvedValue(fakeSession);
    const user = await getCurrentUser();
    expect(user?.id).toBe("user-1");
    expect(user?.role).toBe("USER");
    expect(user?.email).toBe("test@example.com");
  });
});
