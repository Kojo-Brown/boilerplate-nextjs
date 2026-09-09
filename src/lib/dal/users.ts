import { prisma } from "@/lib/prisma";
import { requestMemo } from "@/lib/request-memo";
import { loadUser } from "@/lib/dal/loaders";
import type { User } from "@prisma/client";

export type UserProfile = Pick<
  User,
  "id" | "name" | "email" | "image" | "role" | "createdAt"
>;

const USER_PROFILE_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
  role: true,
  createdAt: true,
} as const;

/**
 * One user profile by id.
 *
 * Reads through the request-scoped batch loader: a single call is one
 * statement, and N calls for N different ids — a list rendering an author per
 * row — are one `… WHERE "id" IN (…)` rather than N. See `@/lib/dal/batch`.
 */
export function getUserById(id: string): Promise<UserProfile | null> {
  return loadUser(id);
}

/**
 * One user profile by email.
 *
 * Memoised rather than batched. It could share the loader's cache by writing
 * both rows under both keys, and that is a cache with two key spaces for one
 * row, where an eviction from either has to remember the other. Email lookups
 * happen once per request, in registration and sign-in, so there is nothing to
 * batch — this only has to stop being issued twice.
 */
export const getUserByEmail = requestMemo(
  async (email: string): Promise<UserProfile | null> =>
    prisma.user.findUnique({
      where: { email },
      select: USER_PROFILE_SELECT,
    }),
);

export const getAllUsers = requestMemo(async (): Promise<UserProfile[]> =>
  prisma.user.findMany({
    select: USER_PROFILE_SELECT,
    orderBy: { createdAt: "desc" },
  }),
);
