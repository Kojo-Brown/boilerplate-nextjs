import type { Metadata } from "next";
import { Toaster } from "sonner";
import { QueryProvider } from "@/components/providers/query-provider";
import { SessionProvider } from "@/components/providers/session-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: { default: "App", template: "%s | App" },
  description: "Next.js boilerplate",
};

/**
 * The root layout deliberately does not read the session.
 *
 * `auth()` reads cookies, and a cookie read in the root layout is inherited by
 * every route beneath it — which made all 14 routes dynamic, including the ones
 * Phase 5 added as ISR. `app/blog`'s `export const revalidate = 60` had never
 * taken effect: the build's route table showed no Revalidate column for it at
 * all, because the page was re-rendered on demand for every request.
 *
 * With the read gone, `/`, `/blog`, `/login`, `/register` and `/forbidden`
 * prerender as static content. `scripts/assert-route-shape.ts` asserts exactly
 * that after every build, so re-introducing a cookie read up here fails CI
 * rather than silently un-doing this.
 *
 * The cost is that `<SessionProvider>` no longer receives a server-rendered
 * session and fetches `/api/auth/session` on mount instead — see the note in
 * `components/providers/session-provider.tsx`. Server components that need the
 * session still read it directly via `getSession()`; they just do it inside a
 * `<Suspense>` boundary of their own rather than at the root of the tree.
 *
 * ---
 *
 * `modal` is a parallel route slot (`app/@modal`), and it is at the root
 * because that is where the interception has to be anchored: `@modal` and
 * `photos` must be siblings for `(.)photos/[id]` to resolve. It renders
 * `app/@modal/default.tsx` — `null` — on every URL that is not a photo, so it
 * adds no markup to any other route and none of the static shells changed when
 * it was introduced. See docs/intercepting-routes.md.
 */
export default function RootLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <SessionProvider>
            <QueryProvider>
              {children}
              {modal}
              <Toaster richColors closeButton />
            </QueryProvider>
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
