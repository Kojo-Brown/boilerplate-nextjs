"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";
import type { Session } from "next-auth";

interface SessionProviderProps {
  children: React.ReactNode;
  session?: Session | null;
}

/**
 * Wraps NextAuth's SessionProvider so client components can call `useSession()`.
 *
 * The root layout mounts this **without** a `session`. That is a deliberate
 * trade, not an oversight. Seeding the provider from the server means awaiting
 * `auth()` above every route, and because that reads cookies it makes the whole
 * application dynamic — which is precisely what kept `/blog`'s ISR from ever
 * engaging. The static shell is worth more than the round trip.
 *
 * The round trip is real, though: with no `session` prop NextAuth's provider
 * calls `/api/auth/session` once on mount (`__NEXTAUTH._session === undefined`
 * takes the fetch branch in `next-auth/react`), for signed-out visitors too.
 * Passing a `session` — including an explicit `null` — suppresses that fetch.
 *
 * So pass one on a subtree that is already dynamic and already has the session
 * in hand, where the fetch buys nothing:
 *
 * @example
 * // in a layout that has already awaited getRequiredSession()
 * <SessionProvider session={session}>{children}</SessionProvider>
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
