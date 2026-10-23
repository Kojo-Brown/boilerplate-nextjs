"use client";

import { NextIntlClientProvider } from "next-intl";
import type { AbstractIntlMessages } from "next-intl";
import type { Locale } from "@/i18n/locales";

interface IntlProviderProps {
  locale: Locale;
  messages: AbstractIntlMessages;
  children: React.ReactNode;
}

/**
 * The catalogue, into client components, without an async component in the root
 * layout.
 *
 * `next-intl` exports two different things under the name
 * `NextIntlClientProvider`, and which one you get depends on the module that
 * imports it. From a Server Component it resolves to
 * `NextIntlClientProviderServer`, an **async** component that fills in
 * whichever of `locale`, `messages`, `formats`, `now` and `timeZone` it was not
 * given by awaiting the request config. From a `"use client"` module — this one
 * — it resolves to the provider itself, which is synchronous and takes what it
 * is handed.
 *
 * That difference ended the build. Under `cacheComponents` an async Server
 * Component that reads uncached data has to sit inside a `<Suspense>`, and this
 * one sits in the root layout above every route:
 *
 *     Route "/[locale]/photos/[id]": Uncached data was accessed outside of
 *     <Suspense>. ... at RootLayout (src/app/[locale]/layout.tsx:216:15)
 *
 * on 86 of 86 pages. Passing `locale` and `messages` was not enough, because
 * `formats`, `now` and `timeZone` are each defaulted with their own `await` —
 * so the component is async whatever you hand it.
 *
 * The two fixes that were not taken, and why:
 *
 *  - **Wrap the providers in `<Suspense>`.** That makes the error go away by
 *    putting every page's entire body behind a boundary, which is precisely the
 *    regression `scripts/assert-route-shape.ts` and
 *    `scripts/assert-streaming-boundaries.ts` exist to catch. The build would
 *    have gone green and both gates would have gone red.
 *  - **Pass `now` as well.** It would silence the last await by pinning a
 *    timestamp into a prerendered document — a "current time" baked at build
 *    time, which is worse than not having one.
 *
 * Neither is needed: nothing here is per-request. The locale comes from the
 * segment, which `generateStaticParams` enumerates, and the catalogue is a
 * static import. This component is the boundary that lets the layout say so.
 *
 * `timeZone` and `formats` are deliberately not passed through. The provider
 * tolerates their absence — `useFormatter` falls back to the runtime's own zone
 * — and this application formats no dates through `next-intl`. Adding them
 * would mean choosing a zone for a prerendered document, which is the same
 * mistake as `now` in a quieter form.
 */
export function IntlProvider({
  locale,
  messages,
  children,
}: IntlProviderProps) {
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
