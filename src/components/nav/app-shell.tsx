"use client";

import React from "react";
import { NavLinks } from "./nav-links";
import { MobileDrawer } from "./mobile-drawer";

interface AppShellProps {
  children: React.ReactNode;
  headerSlot: React.ReactNode;
  appName?: string;
}

export function AppShell({
  children,
  headerSlot,
  appName = "App",
}: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside
        className="hidden lg:flex lg:w-60 lg:flex-shrink-0 lg:flex-col lg:border-r"
        style={{ backgroundColor: "var(--background)" }}
      >
        <div className="border-b px-4 py-3">
          <span className="font-semibold tracking-tight">{appName}</span>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <NavLinks />
        </div>
      </aside>

      {/* Mobile drawer (portal, lg:hidden inside) */}
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        appName={appName}
      />

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="sticky top-0 z-10 border-b px-4 py-3 lg:px-6"
          style={{ backgroundColor: "var(--background)" }}
        >
          <div className="flex items-center gap-3">
            {/* Hamburger — mobile only */}
            <button
              type="button"
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              aria-controls="mobile-drawer"
              className="rounded-md p-1.5 transition-colors hover:bg-[var(--muted)] lg:hidden"
              onClick={() => setDrawerOpen(true)}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="18" x2="20" y2="18" />
              </svg>
            </button>

            {/* App name — mobile only (sidebar shows it on desktop) */}
            <span className="font-semibold tracking-tight lg:hidden">
              {appName}
            </span>

            <div className="ml-auto flex items-center gap-3">{headerSlot}</div>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 lg:px-6 lg:py-8">
          <div className="mx-auto max-w-5xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
