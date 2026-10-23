"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/cn";
import { NAV_ITEMS } from "./nav-items";

interface NavLinksProps {
  onNavigate?: () => void;
  className?: string;
}

/**
 * `usePathname` and `Link` both come from `@/i18n/navigation`, and both have to.
 *
 * `usePathname` from `next/navigation` returns the real URL path, locale prefix
 * included: on `/ar/dashboard` it is `"/ar/dashboard"`, which equals none of the
 * `NAV_ITEMS` hrefs and starts with none of them either. Every item would have
 * rendered unhighlighted and without `aria-current` for every locale but the
 * default — a navigation that silently stops telling a screen reader which page
 * it is on, in the one locale nobody on the team reads. The wrapper strips the
 * prefix, so the comparison is against the same public paths the hrefs are
 * written in.
 */
export function NavLinks({ onNavigate, className }: NavLinksProps) {
  const pathname = usePathname();
  const t = useTranslations("nav");

  return (
    <nav
      className={cn("flex flex-col gap-1", className)}
      aria-label={t("label")}
    >
      {NAV_ITEMS.map(({ labelKey, href }) => {
        const isActive = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            {...(onNavigate && { onClick: onNavigate })}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "text-[var(--foreground)] hover:bg-[var(--muted)]",
            )}
          >
            {t(labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
