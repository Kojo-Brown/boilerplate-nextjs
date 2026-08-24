import type { Metadata } from "next";
import { Suspense } from "react";
import { DashboardFrame } from "./_components/dashboard-frame";
import {
  SessionFields,
  SessionFieldsFallback,
  SessionGreeting,
  SessionGreetingFallback,
} from "./_components/session-summary";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Your dashboard",
};

/**
 * Synchronous on purpose — see `docs/streaming.md`.
 *
 * This page used to open with `await getRequiredSession()`, which put every
 * byte it renders behind the cookie read: the `<h1>`, the card, the field
 * labels. Under Cache Components that meant `/dashboard`'s static shell
 * contained the sidebar and nothing else, and a visitor watched a whole-page
 * skeleton where a heading could have painted immediately.
 *
 * Now the page reads nothing. The two things that genuinely depend on the
 * request — the greeting and the four session values — each sit behind their
 * own boundary, and everything around them prerenders at build time.
 */
export default function DashboardPage() {
  return (
    <DashboardFrame
      greeting={
        <Suspense fallback={<SessionGreetingFallback />}>
          <SessionGreeting />
        </Suspense>
      }
      fields={
        <Suspense fallback={<SessionFieldsFallback />}>
          <SessionFields />
        </Suspense>
      }
    />
  );
}
