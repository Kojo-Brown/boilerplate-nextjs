import * as React from "react";
import {
  render,
  type RenderOptions,
  type RenderResult,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
// The real catalogues the application ships, not a fixture. A test that
// rendered against `{nav: {dashboard: "Dashboard"}}` written here would pass
// whether or not `messages/en.json` still contained that key, which makes it a
// test of the fixture; this way a renamed key breaks the component test that
// depends on it.
import { CATALOGUES } from "@/i18n/catalogues";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/locales";

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
