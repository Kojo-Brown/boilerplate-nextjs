import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { requestMemo } from "@/lib/request-memo";
import type { Session } from "next-auth";

export type { Session };

export type SessionUser = {
  id: string;
  role: "USER" | "ADMIN";
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

export type AuthSession = Omit<Session, "user"> & { user: SessionUser };

/**
 * Returns the current session or null — safe to call in any server component.
 *
 * Memoised per request, because "safe to call in any server component" is an
 * invitation that was accepted: measured against a live server, one
 * `/dashboard` request called this **seven** times and one `/posts` request
 * three — the sidebar's `<UserChip>`, the greeting, the field list, each of the
 * three parallel-route slots — and none of them can see the others, which is
 * the point of rendering them independently. Seven calls meant seven JWT
 * decodes of one cookie; under the database session strategy it would have been
 * seven queries. Both are one now.
 *
 * The memo wraps this rather than `auth()` so everything that reads a session —
 * including `getRequiredSession` and `getRequiredAdminSession`, which are
 * `getSession` plus a redirect — shares one entry.
 */
export const getSession = requestMemo(
  async (): Promise<AuthSession | null> => (await auth()) as AuthSession | null,
);

/**
 * Returns the current session, redirecting to /login if there is none.
 * Use in server components/layouts that require authentication.
 */
export async function getRequiredSession(): Promise<AuthSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/** Returns the authenticated user object or null. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await getSession();
  return session?.user ?? null;
}

/**
 * Returns the current session if the user is authenticated and has the ADMIN role.
 * Redirects to /login if not authenticated, or /forbidden if authenticated but not ADMIN.
 */
export async function getRequiredAdminSession(): Promise<AuthSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.user.role !== "ADMIN") redirect("/forbidden");
  return session;
}
