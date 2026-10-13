import { cn } from "@/lib/cn";
import { MAIN_CONTENT_ID } from "@/lib/a11y/route-focus";

export interface MainContentProps extends Omit<
  React.ComponentPropsWithoutRef<"main">,
  "id" | "tabIndex"
> {
  children: React.ReactNode;
}

/**
 * The `<main>` landmark, and the one focus target the application has.
 *
 * A Server Component: it renders markup and nothing else, and the two
 * attributes that make it work are both static.
 *
 * `tabIndex={-1}` is the load-bearing one and it is counter-intuitive, because
 * the usual reason to write it is to take something *out* of the tab order.
 * `<main>` is not in the tab order to begin with; what the attribute adds is
 * the ability to be focused programmatically or as a fragment target. Without
 * it, `#main-content` in the address bar scrolls the element into view and
 * leaves focus on `<body>`, so the skip link moves the viewport and not the
 * keyboard — the next Tab goes back to the second link in the header. This is
 * the single most common way a skip link is shipped broken, and it looks
 * entirely correct to a sighted mouse user.
 *
 * The id is fixed and may only be rendered here, because it is the skip link's
 * destination. Two elements carrying it would make the fragment resolve to
 * whichever the browser saw first and `<RouteFocus>` focus the other;
 * `scripts/assert-focus-management.ts` fails on a raw `<main>` anywhere in
 * `src/app` and on a duplicate id in any prerendered document.
 *
 * The focus ring is deliberate, and deliberately `focus-visible` rather than
 * `focus`. Moving focus to a region with no visible indicator leaves a
 * keyboard user with no way to tell where they are — that is what 2.4.7 is
 * about, and a skip link is exactly the interaction where it bites. But the
 * same element is focused programmatically after every mouse-driven
 * navigation, and an outline drawn around the page content on every click is
 * noise that teams remove along with the keyboard case. `:focus-visible` is
 * the distinction the platform already makes: Chromium and Firefox match it
 * for a programmatic focus only when the last interaction was a keyboard one.
 *
 * `outline-offset` is negative on purpose. `<main>` fills the column, so a
 * positive offset draws the ring off the edges of the viewport and the visitor
 * sees two thirds of a rectangle.
 */
export function MainContent({
  className,
  children,
  ...props
}: MainContentProps) {
  return (
    <main
      id={MAIN_CONTENT_ID}
      tabIndex={-1}
      className={cn(
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--primary)]",
        className,
      )}
      {...props}
    >
      {children}
    </main>
  );
}
