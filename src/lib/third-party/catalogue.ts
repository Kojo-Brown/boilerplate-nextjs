/**
 * Every origin a visitor's browser is asked to contact that this repository
 * does not serve, and the terms on which it is contacted.
 *
 * Third-party code is the one category of page weight that does not show up in
 * a diff. A tag manager snippet is four lines; what it loads is decided by
 * someone outside the repository, after the build, at runtime, and can change
 * on a Tuesday without a commit here. The bundle budget gate measures what
 * *this* build emits — it reads the documents and the chunks Next wrote — so a
 * third-party script is invisible to it by construction: it is never in the
 * manifest, never in a chunk, and adds nothing to any route's first-load
 * JavaScript. Every gate in this repository can be green on a page that spends
 * two seconds of main thread in a vendor's script.
 *
 * So the control is not a size limit, it is a declaration. This file is the
 * inventory, `scripts/assert-third-party-scripts.ts` is the audit that keeps
 * the inventory honest, and the two together make adding an origin a decision
 * someone has to write down rather than a `src=` nobody notices.
 *
 * Three things are recorded per entry and each of them is enforced:
 *
 *  1. **How it loads.** `next/script`'s `strategy` prop decides whether a
 *     script competes with hydration (`afterInteractive`), waits for idle
 *     (`lazyOnload`), or blocks it outright (`beforeInteractive`). Omitting it
 *     picks `afterInteractive` silently, which is why the audit rejects an
 *     omitted `strategy` rather than letting the default stand: a default is
 *     not a decision, and the cost of the wrong one here is paid by every
 *     visitor on every page.
 *
 *  2. **Whether it loads at all before the visitor asks.** A `facade` entry is
 *     not loaded on render. It is represented by markup this repository serves
 *     — a poster frame, a button — and the third party is fetched on the first
 *     interaction that needs it. For an embed, that is the difference between
 *     every reader of an article paying for a player and only the readers who
 *     press play paying for it.
 *
 *  3. **Whether the connection is warmed.** `preconnect` is a real win for an
 *     origin the page is certainly going to use and a real cost for one it
 *     probably will not: it opens a socket and completes a TLS handshake
 *     against a budget of connections the browser is also using for first-party
 *     requests. Preconnecting a facade's origin therefore undoes most of the
 *     facade — the handshake happens on every page view whether or not anyone
 *     presses play — and the audit fails on it.
 *
 * Nothing here is read at request time and nothing here is a secret: the whole
 * point is that the list is public, reviewable, and the same in every
 * environment. What differs per deployment is only whether an entry is
 * *configured* — see `selectActiveScripts`.
 */

/** `next/script`'s loading strategies, as the library spells them. */
export type ScriptStrategy =
  "beforeInteractive" | "afterInteractive" | "lazyOnload" | "worker";

/**
 * How the browser comes to contact an origin.
 *
 * `asset` is here because an image host is a third party too. `next/image`
 * makes `images.unsplash.com` feel like part of the application, but it is a
 * DNS lookup, a TLS handshake and a request to someone else's server on a page
 * this repository prerenders — and it is configured in `next.config.ts`, a file
 * the component gates never read. The audit reads it.
 */
export type ThirdPartyLoading =
  | { readonly mode: "script"; readonly strategy: ScriptStrategy }
  | { readonly mode: "facade" }
  | { readonly mode: "asset" };

export interface ThirdParty {
  /** Stable identifier. Referenced by the module that mounts the entry. */
  readonly id: string;
  readonly title: string;
  /**
   * The hostnames the browser contacts, written the way the thing that
   * configures them writes them — so an `asset` entry may carry one of
   * `next.config.ts`'s wildcard patterns (`**.googleusercontent.com`).
   *
   * A wildcard is not preconnectable: `rel="preconnect"` takes one origin and
   * there is no origin to name until a URL is in hand. The audit enforces that
   * rather than leaving it to be discovered as a hint the browser ignored.
   */
  readonly hosts: readonly string[];
  readonly loading: ThirdPartyLoading;
  /** Emit `<link rel="preconnect">` for this entry's hosts on every document. */
  readonly preconnect: boolean;
  /**
   * The repository-relative module that mounts this entry.
   *
   * Required for `script` and `facade` entries, and checked both ways: the file
   * must exist and must name this entry's id, so an inventory entry cannot
   * describe a third party nothing loads, and a mount cannot drift onto an
   * origin the inventory never heard of. `asset` entries have no mounting
   * module — they are configured in `next.config.ts` and requested by whichever
   * `next/image` happens to receive a matching URL — so theirs is `null`.
   */
  readonly mountedBy: string | null;
  /** Why this origin is worth what it costs. Read by humans, not by code. */
  readonly why: string;
}

export const THIRD_PARTY_SCRIPTS_MODULE =
  "src/components/third-party/third-party-scripts.tsx";

export const VIDEO_FACADE_MODULE =
  "src/components/third-party/video-facade.tsx";

/** The analytics host. Also the id the mounting module must name. */
export const PLAUSIBLE_ID = "plausible";
export const YOUTUBE_ID = "youtube";

/**
 * The origin the video facade loads once a visitor presses play.
 *
 * `youtube-nocookie.com` rather than `youtube.com`: the privacy-enhanced origin
 * sets no cookie and stores nothing until playback begins, which is what makes
 * it defensible to embed a player at all without a consent prompt in front of
 * it. The facade makes that stricter still — nothing is contacted until the
 * press — but the origin matters for the request the press then makes.
 */
export const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

export const PLAUSIBLE_SCRIPT_SRC = "https://plausible.io/js/script.js";

export const THIRD_PARTIES: readonly ThirdParty[] = [
  {
    id: PLAUSIBLE_ID,
    title: "Plausible Analytics",
    hosts: ["plausible.io"],
    // `afterInteractive` rather than `lazyOnload`, and the difference is not a
    // performance preference — it is whether the data exists. `lazyOnload`
    // waits for the window `load` event, and a visitor who bounces before it
    // fires is never counted; the pages that lose those visitors are the slow
    // ones, so the metric would be biased in exactly the direction that hides
    // the problem. `afterInteractive` runs the script after hydration, which
    // costs one 1 kB request off the critical path and counts everyone.
    //
    // `beforeInteractive` would be the wrong answer for any analytics script
    // and is rejected for this one by the audit's root-layout rule regardless:
    // it blocks hydration on a vendor's server responding.
    loading: { mode: "script", strategy: "afterInteractive" },
    // Certain to be used on every page where it is configured at all, and the
    // handshake is on the critical path of a request that happens right after
    // hydration. This is the case preconnect exists for.
    preconnect: true,
    mountedBy: THIRD_PARTY_SCRIPTS_MODULE,
    why:
      "Page-level traffic analytics. Chosen over the ad-funded options because " +
      "it sets no cookie, collects no cross-site identifier and ships ~1 kB, " +
      "so it needs no consent banner in front of it — a banner is itself a " +
      "layout shift and an interaction cost on every first visit. Inert unless " +
      "NEXT_PUBLIC_PLAUSIBLE_DOMAIN is set, so a checkout of this repository " +
      "sends nothing anywhere.",
  },
  {
    id: YOUTUBE_ID,
    title: "YouTube embedded player",
    hosts: ["www.youtube-nocookie.com"],
    loading: { mode: "facade" },
    // Deliberately false, and the audit enforces it. An article page that
    // preconnects to the player has already paid a DNS lookup and a TLS
    // handshake for every reader, including the overwhelming majority who never
    // press play — which is most of what the facade was built to avoid. The
    // facade warms the connection on hover and focus instead, where the
    // evidence that the visitor is about to need it is real.
    preconnect: false,
    mountedBy: VIDEO_FACADE_MODULE,
    why:
      "Video embedded in article bodies. The player is ~1.2 MB of JavaScript " +
      "across ~10 requests and runs before the visitor has decided to watch " +
      "anything, so it is loaded behind a facade: a poster frame and a play " +
      "button this repository serves, and an iframe only after the press.",
  },
  {
    id: "unsplash-images",
    title: "Unsplash image CDN",
    hosts: ["images.unsplash.com"],
    loading: { mode: "asset" },
    // The gallery's LCP element is an Unsplash URL, so the handshake is on the
    // critical path of the largest paint on /photos and /images. An asset host
    // is not script — it costs a connection, not main thread — and this is the
    // one where warming it pays for itself.
    preconnect: true,
    mountedBy: null,
    why:
      "Demo photography for the /photos gallery and the next/image showcase. " +
      "Declared in next.config.ts's remotePatterns, which is what actually " +
      "permits the request.",
  },
  {
    id: "google-avatars",
    title: "Google account avatars",
    hosts: ["**.googleusercontent.com"],
    loading: { mode: "asset" },
    // Cannot be preconnected even if it were worth it: the host is a wildcard
    // pattern, and `rel="preconnect"` has no origin to name until a signed-in
    // user's avatar URL is in hand. The audit fails on `preconnect: true` here
    // rather than letting a hint be emitted that browsers silently drop.
    preconnect: false,
    mountedBy: null,
    why:
      "Profile pictures for accounts that signed in with Google. Requested " +
      "only for signed-in users, from a per-account subdomain, so there is no " +
      "single origin to warm and nothing to request for a visitor who is " +
      "signed out.",
  },
];

export function findThirdParty(id: string): ThirdParty | undefined {
  return THIRD_PARTIES.find((entry) => entry.id === id);
}

/**
 * The deployment-specific half: which declared scripts are configured.
 *
 * Split from the catalogue rather than folded into it because they answer
 * different questions and are read by different things. The catalogue is a
 * property of the source and is the same everywhere, which is what lets a
 * static audit check it; whether an account is configured is a property of one
 * environment. Passing the configuration in rather than reading `process.env`
 * here keeps both testable, and keeps this module importable from the audit
 * script, which runs in plain Node with none of the application's environment.
 */
export interface ThirdPartyConfig {
  /** The site's registered domain, or undefined when analytics is not set up. */
  readonly plausibleDomain?: string | undefined;
}

export interface ActiveScript {
  readonly thirdParty: ThirdParty;
  readonly src: string;
  readonly strategy: ScriptStrategy;
  /** `data-*` attributes the vendor's script reads. */
  readonly attributes: Readonly<Record<string, string>>;
}

/**
 * The `script`-mode entries this deployment should actually mount.
 *
 * Returning nothing for an unconfigured deployment is the supported default,
 * not a degraded mode: a fresh clone, a preview deployment and the CI build all
 * run with no analytics domain and must send no traffic to a vendor. A blank
 * domain is treated as unset for the same reason `src/lib/env.ts` preprocesses
 * empty strings — `NEXT_PUBLIC_PLAUSIBLE_DOMAIN=` in a `.env` file sets the
 * variable to `""`, which is present, and mounting a script with an empty
 * `data-domain` would report every page view under no site at all.
 */
export function selectActiveScripts(
  config: ThirdPartyConfig,
): readonly ActiveScript[] {
  const active: ActiveScript[] = [];

  const domain = config.plausibleDomain?.trim();
  const plausible = findThirdParty(PLAUSIBLE_ID);

  if (domain && plausible && plausible.loading.mode === "script") {
    active.push({
      thirdParty: plausible,
      src: PLAUSIBLE_SCRIPT_SRC,
      strategy: plausible.loading.strategy,
      attributes: { "data-domain": domain },
    });
  }

  return active;
}

/**
 * The origins to warm, given what this deployment actually mounts.
 *
 * A `script` entry only earns its preconnect when it is configured — an
 * unconfigured analytics account would otherwise have every document opening a
 * connection to a vendor it never speaks to, which is both a wasted handshake
 * and a request appearing in a network log that nothing in the page explains.
 * `facade` and wildcard entries are excluded by the catalogue itself, and the
 * audit checks that they are.
 */
export function selectPreconnectOrigins(
  config: ThirdPartyConfig,
): readonly string[] {
  const activeScriptIds = new Set(
    selectActiveScripts(config).map((script) => script.thirdParty.id),
  );

  const origins: string[] = [];

  for (const entry of THIRD_PARTIES) {
    if (!entry.preconnect) continue;
    if (entry.loading.mode === "script" && !activeScriptIds.has(entry.id)) {
      continue;
    }
    for (const host of entry.hosts) {
      origins.push(`https://${host}`);
    }
  }

  return origins;
}
