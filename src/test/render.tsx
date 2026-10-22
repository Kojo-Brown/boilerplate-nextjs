import * as React from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/locales";

/**
 * The real catalogues, not a fixture.
 *
 * A test that renders against `{nav: {dashboard: "Dashboard"}}` written here
 * passes whether or not `messages/en.json` still contains that key — which
 * makes it a test of the fixture. Importing the shipped files means a renamed
 * key breaks the component test that depends on it, which is the only place a
 * rename *can* break before it reaches a page.
 */
const CATALOGUES: Record<Locale, typeof en> = { en, ar };

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  queryClient?: QueryClient;
  /**
   * The locale the component is rendered under. Defaults to `DEFAULT_LOCALE`,
   * so a test that does not care reads the English strings it always did.
   *
   * Pass `"ar"` to assert the half of a component that only an RTL locale with
   * six plural categories can reach — a flattened plural, a label that was
   * never extracted, or a pathname comparison that forgot the locale prefix.
   */
  locale?: Locale;
}

interface RenderWithProvidersResult extends RenderResult {
  user: UserEvent;
  queryClient: QueryClient;
}

export function renderWithProviders(
  ui: React.ReactElement,
  {
    queryClient = makeQueryClient(),
    locale = DEFAULT_LOCALE,
    ...renderOptions
  }: RenderWithProvidersOptions = {},
): RenderWithProvidersResult {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </NextIntlClientProvider>
    );
  }

  const user = userEvent.setup();

  return {
    user,
    queryClient,
    ...render(ui, { wrapper: Wrapper, ...renderOptions }),
  };
}
