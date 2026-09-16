import Script from "next/script";
import {
  PLAUSIBLE_ID,
  selectActiveScripts,
  selectPreconnectOrigins,
} from "@/lib/third-party/catalogue";
import type { ThirdPartyConfig } from "@/lib/third-party/catalogue";

/**
 * Mounts the `script`-mode entries of the third-party catalogue, and the
 * resource hints that go with them.
 *
 * A Server Component on purpose. `next/script` is usable from one — the
 * `<Script>` element is a client component, but nothing *around* it here has to
 * be — so the decision of which scripts a deployment loads is made during the
 * render on the server and never reaches the browser as configuration. The
 * alternative, a `"use client"` wrapper reading `process.env.NEXT_PUBLIC_*`,
 * ships the whole selection to every visitor and re-runs it in every browser to
 * arrive at the answer the server already had.
 *
 * The catalogue supplies both `src` and `strategy`, rather than this file
 * spelling them out. That is what makes `src/lib/third-party/catalogue.ts` the
 * single record of what loads and how: a change of strategy is a change to the
 * inventory, reviewed as one, instead of a one-word edit inside a component.
 *
 * `PLAUSIBLE_ID` is imported rather than written out so that the audit can tie
 * this module to the catalogue entry that names it as its mount — see rule R6
 * in `scripts/assert-third-party-scripts.ts`.
 *
 * See docs/third-party-scripts.md.
 */
export function ThirdPartyScripts({
  config,
}: {
  /**
   * Passed in rather than read here so the component can be rendered in a test
   * without an environment, and so the root layout stays the one place that
   * decides what this deployment is configured with.
   */
  config: ThirdPartyConfig;
}) {
  const scripts = selectActiveScripts(config);
  const preconnectOrigins = selectPreconnectOrigins(config);

  return (
    <>
      {/*
        React 19 hoists `<link>` into `<head>`, so these are written next to the
        scripts they belong to rather than in a separate head fragment that
        would drift from this list. `crossOrigin` is required and not optional
        decoration: a preconnect without it opens a connection in the
        *uncredentialed* pool, and a script fetched with `crossorigin` set — or
        any CORS request — then cannot reuse it and opens a second one. Getting
        this wrong costs an extra handshake instead of saving one.
      */}
      {preconnectOrigins.map((origin) => (
        <link key={origin} rel="preconnect" href={origin} crossOrigin="" />
      ))}

      {scripts.map((script) => (
        <Script
          key={script.thirdParty.id}
          id={`third-party-${script.thirdParty.id}`}
          src={script.src}
          // Always explicit, always from the catalogue. `next/script` defaults
          // to `afterInteractive` when this is omitted, which means the most
          // consequential property of a third-party script is decided by
          // whoever forgot to type it.
          strategy={script.strategy}
          {...script.attributes}
        />
      ))}
    </>
  );
}

/** The catalogue ids this module is responsible for mounting. */
export const MOUNTED_THIRD_PARTY_IDS = [PLAUSIBLE_ID] as const;
