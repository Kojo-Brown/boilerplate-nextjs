import { Suspense } from "react";
import { AppShell } from "@/components/nav/app-shell";
import { UserChip, UserChipSkeleton } from "@/components/session/user-chip";

/**
 * Synchronous on purpose.
 *
 * This layout used to `await getRequiredSession()` in its body. Everything it
 * renders — sidebar, navigation, header, and the page inside it — therefore sat
 * behind a cookie read, and under Cache Components that meant the static shell
 * for every dashboard route was an empty document: `/posts` prerendered 2.6 KB
 * consisting of a `<title>`.
 *
 * Now the chrome prerenders and only `<UserChip>` is a streamed hole.
 *
 * The session read that used to live here was also doing double duty as an
 * authorisation check, and two routes leaned on it: `/images` and `/upload` are
 * absent from `PROTECTED_PREFIXES` in `auth.config.ts`, so the proxy does not
 * gate them. Both now call `getRequiredSession()` themselves. That is where the
 * check belonged regardless of PPR — a layout does not re-render when the user
 * navigates between sibling routes that share it, so a layout is not a place to
 * enforce access.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AppShell
      appName="App"
      headerSlot={
        <Suspense fallback={<UserChipSkeleton />}>
          <UserChip />
        </Suspense>
      }
    >
      {children}
    </AppShell>
  );
}
