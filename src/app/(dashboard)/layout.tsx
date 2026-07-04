import { getRequiredSession } from "@/lib/session";
import { UserAvatar } from "@/components/session/user-avatar";
import { signOutAction } from "@/actions/auth";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getRequiredSession();

  return (
    <div className="flex min-h-screen flex-col">
      <header
        className="sticky top-0 z-10 border-b px-6 py-3"
        style={{ backgroundColor: "var(--background)" }}
      >
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <span className="font-semibold tracking-tight">App</span>
          <div className="flex items-center gap-3">
            <span
              className="text-sm"
              style={{ color: "var(--muted-foreground)" }}
            >
              {session.user.name ?? session.user.email}
            </span>
            <UserAvatar size="sm" />
            <form action={signOutAction}>
              <button
                type="submit"
                className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
