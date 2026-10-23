import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import type { Metadata } from "next";
import { Toaster } from "sonner";
import { RouteFocus } from "@/components/a11y/route-focus";
import { SkipLink } from "@/components/a11y/skip-link";
import { QueryProvider } from "@/components/providers/query-provider";
import { SessionProvider } from "@/components/providers/session-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { ThirdPartyScripts } from "@/components/third-party/third-party-scripts";
import { WebVitalsReporter } from "@/components/vitals/web-vitals-reporter";
import { IntlProvider } from "@/components/providers/intl-provider";
import { CATALOGUES } from "@/i18n/catalogues";
import { LOCALES, isLocale, textDirection } from "@/i18n/locales";
import { clientEnv } from "@/lib/env/client";
import { fontVariables } from "@/styles/fonts";
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
 *
 * ---
 *
 * `<WebVitalsReporter>` is here and can only be here: it subscribes to
 * measurements taken during the first paint, so a reporter mounted any deeper
 * in the tree misses the landing page's LCP and TTFB on every visit. It renders
 * `null` and reads no cookies, so it adds no markup and makes nothing dynamic —
 * `scripts/assert-vitals-wiring.ts` fails the build if it goes missing from
 * this file, because telemetry that has stopped being collected looks exactly
 * like telemetry nobody has looked at. See docs/web-vitals.md.
 *
 * ---
 *
 * `<ThirdPartyScripts>` is here for a different reason than the reporter above
 * it: not because it has to be, but because there must be exactly one place
 * third-party scripts are mounted from, and the root layout is the only node
 * every route shares. Scattering `<Script>` across the pages that happen to
 * need a vendor is how an inventory stops being an inventory. It is a Server
 * Component, reads no cookies and renders nothing of its own when nothing is
 * configured — which is the default — so it makes no route dynamic and adds no
 * markup to a checkout that has not set an analytics domain. The decision of
 * *what* loads and *how* lives in `src/lib/third-party/catalogue.ts`;
 * `scripts/assert-third-party-scripts.ts` is the audit over it. See
 * docs/third-party-scripts.md.
 *
 * ---
 *
 * `<SkipLink>` is the first element in `<body>` and that position is the whole
 * feature: a skip link rendered after the navigation it exists to skip is
 * decoration. It is above `<ThemeProvider>` rather than inside it for the same
 * reason — the providers are where a wrapper gets added, and a wrapper that
 * renders a banner, a cookie notice or a layout grid above its children moves
 * the skip link down without anyone editing this line.
 *
 * `<RouteFocus>` is here for the reason the reporter above it is: it compares
 * the pathname against the previous one, and a layout does not re-render when
 * the visitor moves between sibling routes inside it, so a copy mounted in a
 * route group would see a first render — and decline to move focus — at every
 * crossing between groups. One mount, at the only node every route shares.
 *
 * It needs no `<Suspense>` boundary and must not have one: it does not read
 * the router until the client has hydrated, which is what keeps
 * `usePathname()` out of the four dynamic-segment fallback shells it cannot be
 * answered in. The component itself explains why a boundary was the wrong fix
 * for that; see also docs/focus-management.md and docs/streaming.md.
 *
 * ---
 *
 * `fontVariables` is on `<html>` because that is the only element the rules
 * that read it are in scope for: `globals.css` resolves `--font-sans` and
 * `--font-mono` from these variables inside `@theme`, which is emitted at
 * `:root`. On `<body>` instead, every `font-sans` utility in the application
 * resolves to the generic fallback and the application renders in a system
 * face that looks almost right. `next-themes` is well behaved about this — it
 * adds and removes its own class with `classList` rather than assigning
 * `className` — so the two coexist on the same element. See docs/fonts.md and
 * `scripts/assert-font-loading.ts`.
 *
 * ---
 *
 * `lang` and `dir` come from the locale registry rather than being written as
 * literals, and `dir` is on this element at all because the logical CSS the
 * components now use resolves against it. `ms-4` compiles to
 * `margin-inline-start`, and `inline-start` is whichever side the *document*
 * says it is — so with no `dir` here every logical utility in the application
 * silently resolves left-to-right, and `scripts/assert-logical-properties.ts`
 * would be guarding a property nothing reads.
 *
 * `lang` and `dir` are the segment's locale now rather than `DEFAULT_LOCALE`,
 * which is the one thing the `[locale]` restructure was for: `dir="rtl"` is
 * what every logical utility in the tree resolves against, so until this
 * element could say `rtl` the whole direction-safe pass was guarding a property
 * nothing read. See docs/i18n.md.
 *
 * ---
 *
 * This is the root layout, and `src/app` has no `layout.tsx` of its own. There
 * cannot be one: a root layout renders `<html>`, `<html lang>` is the locale,
 * and the locale is this segment — a layout above it would have to guess.
 * `app/global-error.tsx` sits outside the segment for the same reason and
 * renders its own `<html>`, which is why it is the one document in the build
 * whose `lang` this file does not decide.
 *
 * ---
 *
 * `setRequestLocale` is what lets everything below here stay static.
 * `useTranslations()` in a Server Component reads the locale from
 * `next-intl`'s request config, which resolves it from the `[locale]` segment
 * — and reading a dynamic segment's value is a request-time read, so a page
 * doing it has nothing to prerender. `setRequestLocale` puts the locale in
 * `next-intl`'s own cache for this render, from a value that came out of
 * `generateStaticParams` rather than out of the request, and every translator
 * below reads it from there. Without this call `scripts/assert-route-shape.ts`
 * fails on every static route in the application, which is exactly how the
 * root layout's old `await auth()` was found.
 */
/**
 * Prerender both locales.
 *
 * Without this the `[locale]` segment has no concrete values at build time and
 * every route under it becomes a dynamic render, which is the same regression
 * the root layout's `await auth()` caused and which
 * `scripts/assert-route-shape.ts` exists to catch.
 */
export function generateStaticParams(): Array<{ locale: string }> {
  return LOCALES.map((locale) => ({ locale }));
}

export default async function RootLayout({
  children,
  modal,
  params,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  // `[locale]` is a dynamic segment at the root of the tree, which makes it a
  // catch-all for anything that matched no file: `/favicon.png` arrives here
  // with `locale` set to `"favicon.png"`. `notFound()` and not a fallback to
  // `DEFAULT_LOCALE`, because the alternative is serving the landing page at
  // every misspelled URL in the application — and `next-intl`'s own request
  // config *does* fall back to the default, so without this the mistake renders
  // a complete, plausible, 200-answering page.
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  // Before any translator below is constructed. See the note above.
  setRequestLocale(locale);

  return (
    <html
      lang={locale}
      dir={textDirection(locale)}
      className={fontVariables}
      suppressHydrationWarning
    >
      <body>
        {/*
          The label is passed in rather than read from the catalogue by
          `<SkipLink>` itself, and the position of this element is why.
          `<SkipLink>` has to be the *first* child of `<body>` — a skip link
          after the navigation it exists to skip is decoration — which puts it
          above `<IntlProvider>`, so there is no context for a
          `useTranslations` of its own to read. Reading it on the server
          instead would make the component async, which is the whole of the
          note on `<IntlProvider>` below.

          The prop already existed, described as "overridable for
          localisation". This is that.
        */}
        <SkipLink>{CATALOGUES[locale].common.skipToContent}</SkipLink>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <SessionProvider>
            <QueryProvider>
              {/*
               * Client Components get the catalogue from here. It is inside
               * the providers rather than wrapping them because only the tree
               * below it calls `useTranslations()`, and the provider
               * serialises the messages it is given into the RSC payload —
               * mounting it higher would not add a string to the bundle, but
               * it would put the one component that must stay a pure
               * pass-through above the ones that have state.
               *
               * It is `@/components/providers/intl-provider` and not
               * `next-intl`'s `NextIntlClientProvider` directly, because from
               * a Server Component that name resolves to an *async* component
               * that awaits the request config — which under
               * `cacheComponents` ends the build on every page in the
               * application. The wrapper is a `"use client"` module, so it
               * gets the synchronous provider and takes the locale and the
               * catalogue as props. Both are statically known: the locale
               * comes from `generateStaticParams` and the catalogue is a
               * static import. See that file and `@/i18n/catalogues`.
               */}
              <IntlProvider locale={locale} messages={CATALOGUES[locale]}>
                {children}
              </IntlProvider>
              {modal}
              <Toaster richColors closeButton />
              <RouteFocus />
              <WebVitalsReporter />
              <ThirdPartyScripts
                config={{
                  plausibleDomain: clientEnv.NEXT_PUBLIC_PLAUSIBLE_DOMAIN,
                }}
              />
            </QueryProvider>
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
