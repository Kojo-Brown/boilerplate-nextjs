import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import { getUserById, getUserByEmail, getAllUsers } from "./users";

const mockUser = {
  id: "user-1",
  name: "Alice",
  email: "alice@example.com",
  image: null,
  role: "USER" as const,
  createdAt: new Date("2024-01-01"),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getUserById", () => {
  it("finds user by id with selected fields", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never);

    const result = await getUserById("user-1");

    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" } }),
    );
    expect(result?.id).toBe("user-1");
  });

  it("returns null for a missing user", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    expect(await getUserById("nonexistent")).toBeNull();
  });
});

describe("getUserByEmail", () => {
  it("finds user by email", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never);

    const result = await getUserByEmail("alice@example.com");

    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "alice@example.com" } }),
    );
    expect(result?.email).toBe("alice@example.com");
  });
});

describe("getAllUsers", () => {
  it("returns users ordered by createdAt desc", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([mockUser] as never);

    const result = await getAllUsers();

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } }),
    );
    expect(result).toHaveLength(1);
  });
});
