import { MainContent } from "@/components/a11y/main-content";
import { ThemeToggle } from "@/components/ui/theme-toggle";

/**
 * `/login` and `/register` have no header to hang the theme control off, so it
 * is pinned to the corner of the shell instead. Leaving it out would make the
 * theme unreachable on the two routes a signed-out visitor is most likely to
 * land on.
 *
 * The `<MainContent>` wrapper is the landmark these two routes did not have.
 * Both rendered a centred `<div>` and nothing else, so there was no `<main>`
 * on the page — the skip link had nowhere to go, and a screen reader's
 * "jump to main content" found no region to jump to, on the first route a
 * signed-out visitor sees. It carries the card's own width constraint rather
 * than `display: contents`, which was the first attempt and cannot work: an
 * element with `contents` generates no box, so there is nothing for the focus
 * ring to be drawn around and the skip link lands somewhere invisible. The
 * centring stays with the flex container around it.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-muted p-4">
      <ThemeToggle className="absolute top-4 end-4" />
      <MainContent className="w-full max-w-sm">{children}</MainContent>
    </div>
  );
}
