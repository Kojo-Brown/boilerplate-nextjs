import { getRequiredSession } from "@/lib/session";
import { UserAvatar } from "@/components/session/user-avatar";
import { signOutAction } from "@/actions/auth";
import { AppShell } from "@/components/nav/app-shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getRequiredSession();

  return (
    <AppShell
      appName="App"
      headerSlot={
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
      }
    >
      {children}
    </AppShell>
  );
}
