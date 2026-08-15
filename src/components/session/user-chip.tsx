import { getRequiredSession } from "@/lib/session";
import { UserAvatar } from "@/components/session/user-avatar";
import { signOutAction } from "@/actions/auth";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The signed-in identity in the dashboard header: name, avatar, sign-out.
 *
 * Split out of `(dashboard)/layout.tsx` so the layout itself can stay
 * synchronous. This is the whole PPR story for the dashboard in one file — the
 * layout used to `await getRequiredSession()` in its body, which put the entire
 * chrome (sidebar, nav, header, page content) behind the session read. The
 * static shell for `/posts` was 2.6 KB: a `<title>` and nothing else. Now the
 * chrome is in the shell and only this chip is a hole.
 *
 * Anything added here should genuinely depend on the session. Anything that
 * does not belongs in `AppShell`, where it gets prerendered.
 */
export async function UserChip() {
  const session = await getRequiredSession();

  return (
    <>
      <span
        className="hidden text-sm lg:block"
        style={{ color: "var(--muted-foreground)" }}
      >
        {session.user.name ?? session.user.email}
      </span>
      <UserAvatar size="sm" />
      <form action={signOutAction}>
        <button
          type="submit"
          className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--muted)]"
        >
          Sign out
        </button>
      </form>
    </>
  );
}

/**
 * Fallback for the chip's Suspense boundary.
 *
 * Sized to match what it replaces — a 28px avatar (`UserAvatar size="sm"`), the
 * name line, and the sign-out button — because a fallback with different
 * dimensions makes the header visibly reflow the moment the hole fills, which
 * is the most common way a PPR migration ends up feeling worse than the
 * fully-dynamic page it replaced.
 */
export function UserChipSkeleton() {
  return (
    <>
      <Skeleton className="hidden h-4 w-28 lg:block" />
      <Skeleton className="h-7 w-7 rounded-full" />
      <Skeleton className="h-[30px] w-20 rounded-lg" />
    </>
  );
}
