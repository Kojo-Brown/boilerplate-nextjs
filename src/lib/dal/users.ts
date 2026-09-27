// Unscoped on purpose: `users` has no tenant column and no policy. A person
// is not owned by a workspace — they are a member of several — so scoping this
// table would make "who wrote this" unanswerable across a tenant boundary that
// the posts themselves already enforce. What a tenant may *learn* about a user
// is bounded by which rows it can read, not by this table.
import { unscopedPrisma } from "@/lib/tenancy/client";
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
    unscopedPrisma.user.findUnique({
      where: { email },
      select: USER_PROFILE_SELECT,
    }),
);

export const getAllUsers = requestMemo(async (): Promise<UserProfile[]> =>
  unscopedPrisma.user.findMany({
    select: USER_PROFILE_SELECT,
    orderBy: { createdAt: "desc" },
  }),
);
