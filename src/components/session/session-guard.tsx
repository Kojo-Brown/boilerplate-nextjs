import { getSession } from "@/lib/session";

interface SessionGuardProps {
  /** Rendered when a valid session exists. */
  children: React.ReactNode;
  /** Rendered when there is no session. Defaults to nothing. */
  fallback?: React.ReactNode;
}

/**
 * Session-aware server component that conditionally renders its children.
 * Use this to show/hide UI sections based on auth state without a redirect.
 *
 * @example
 * <SessionGuard fallback={<SignInLink />}>
 *   <UserMenu />
 * </SessionGuard>
 */
export async function SessionGuard({ children, fallback = null }: SessionGuardProps) {
  const session = await getSession();
  return session ? <>{children}</> : <>{fallback}</>;
}
