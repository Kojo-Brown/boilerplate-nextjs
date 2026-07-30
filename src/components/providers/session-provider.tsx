"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";
import type { Session } from "next-auth";

interface SessionProviderProps {
  children: React.ReactNode;
  session?: Session | null;
}

/**
 * Wraps NextAuth's SessionProvider so client components can call `useSession()`.
 * Pass the server-fetched session to avoid an extra round-trip on mount.
 */
export function SessionProvider({ children, session }: SessionProviderProps) {
  return (
    // Spread conditionally: NextAuth treats an absent `session` as "fetch it on
    // mount" and `null` as "definitely signed out", so forwarding an explicit
    // `undefined` would not mean the same thing as omitting the prop.
    <NextAuthSessionProvider {...(session !== undefined && { session })}>
      {children}
    </NextAuthSessionProvider>
  );
}
