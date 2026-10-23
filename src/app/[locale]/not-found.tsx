import type { Metadata } from "next";
import { Link } from "@/i18n/navigation";
import { MainContent } from "@/components/a11y/main-content";

export const metadata: Metadata = {
  title: "404 — Not Found",
  description: "The page you are looking for does not exist.",
};

/**
 * The application's 404, and the reason it exists is the landmark.
 *
 * Without this file Next renders its own built-in not-found page, which is
 * fine to look at and has no `<main>` in it. Every other route inherits one
 * from `<MainContent>`; `/_not-found` inherited the root layout — so it had
 * the skip link — and then had nothing for that link to point at. Tabbing
 * once on a 404 and pressing Enter moved the viewport and left focus in the
 * header, which is the broken-skip-link behaviour the whole feature exists to
 * prevent, on one of the few routes every visitor eventually reaches.
 *
 * `scripts/assert-focus-management.ts` is what fails now if this goes away:
 * `/_not-found` is in `REQUIRED_DOCUMENTS` there precisely because deleting
 * this file is a silent reversion — the build stays green, the page still
 * renders, and only the skip link stops working.
 *
 * Deliberately shaped like `/forbidden`, which is the application's other
 * terminal page, rather than introducing a second visual language for "this
 * did not work".
 */
export default function NotFound() {
  return (
    <MainContent className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <p
        className="text-7xl font-bold"
        style={{ color: "var(--primary)" }}
        aria-hidden="true"
      >
        404
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">Page Not Found</h1>
      <p
        className="max-w-sm text-sm"
        style={{ color: "var(--muted-foreground)" }}
      >
        The page you are looking for does not exist or has been moved.
      </p>
      <Link
        href="/"
        className="mt-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors"
        style={{
          backgroundColor: "var(--primary)",
          color: "var(--primary-foreground)",
        }}
      >
        Back to Home
      </Link>
    </MainContent>
  );
}
