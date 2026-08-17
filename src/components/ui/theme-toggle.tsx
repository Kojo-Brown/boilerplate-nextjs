"use client";

import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { useIsHydrated } from "@/hooks/use-is-hydrated";

function SunIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function SystemIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

/**
 * Shown only before hydration, when the chosen theme is genuinely unknown.
 *
 * A half-filled disc rather than one of the three real icons: the server cannot
 * know whether the user picked light, dark or system, so rendering any of them
 * would be a guess that is wrong two thirds of the time and would then swap
 * under the user's eye. This says "there is a theme control here" and nothing
 * more.
 */
function ContrastIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

type Theme = "light" | "dark" | "system";

const nextTheme: Record<Theme, Theme> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const themeLabel: Record<Theme, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};

/**
 * Cycles system → light → dark → system through `next-themes`.
 *
 * ## Why the hydration gate
 *
 * `next-themes` seeds its state from `localStorage` in a lazy `useState`
 * initialiser, so the very first *client* render already knows the persisted
 * theme. The server never can: there is no request-time signal for it, which is
 * the whole reason the provider ships a blocking inline script instead. A
 * component that renders `theme` directly therefore emits `System theme` on the
 * server and `Dark theme` during hydration — a mismatch React repairs by
 * discarding the server markup for this subtree, and one that
 * `suppressHydrationWarning` on `<html>` does not cover (it applies to that
 * element's own attributes, which is what the provider's script rewrites, not
 * to descendants).
 *
 * So until hydration the button renders a neutral placeholder. `useIsHydrated`
 * is `false` on the server *and* on the hydrating render, and `true` from the
 * commit onwards, so server and first client render agree by construction —
 * the same reason `MobileDrawer` uses it rather than `useState` in an effect.
 *
 * The placeholder is not `disabled`. Nothing in this application is interactive
 * before hydration, so singling this control out would only add a flash of
 * `disabled:opacity-50` on every page load; the button simply becomes live when
 * its handler attaches, like every other one.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const hydrated = useIsHydrated();
  const current = (theme as Theme) ?? "system";

  if (!hydrated) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className={className}
        aria-label="Theme"
      >
        <ContrastIcon className="h-4 w-4" />
        <span className="sr-only">Theme</span>
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      aria-label={themeLabel[current]}
      onClick={() => setTheme(nextTheme[current])}
    >
      {current === "dark" ? (
        <MoonIcon className="h-4 w-4" />
      ) : current === "light" ? (
        <SunIcon className="h-4 w-4" />
      ) : (
        <SystemIcon className="h-4 w-4" />
      )}
      <span className="sr-only">{themeLabel[current]}</span>
    </Button>
  );
}
