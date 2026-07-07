"use client";

import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

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

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const current = (theme as Theme) ?? "system";

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
