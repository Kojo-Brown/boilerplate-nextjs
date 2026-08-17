import { ThemeToggle } from "@/components/ui/theme-toggle";

/**
 * `/login` and `/register` have no header to hang the theme control off, so it
 * is pinned to the corner of the shell instead. Leaving it out would make the
 * theme unreachable on the two routes a signed-out visitor is most likely to
 * land on.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-muted p-4">
      <ThemeToggle className="absolute top-4 right-4" />
      {children}
    </div>
  );
}
