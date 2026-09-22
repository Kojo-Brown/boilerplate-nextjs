/**
 * The Content Security Policy, and the one thing about it that is not optional
 * reading: **a nonce only reaches markup Next renders on demand.**
 *
 * ## What was measured
 *
 * Next takes the nonce from the *request's* `Content-Security-Policy` header
 * (`parseRequestHeaders` in `next/dist/server/app-render/app-render.js`) and
 * hands it to the renderer, which stamps it on every script it writes. That
 * happens during a render. A prerendered document is not rendered during the
 * request — it is a file on disk, written at build time, when no request and no
 * nonce existed. Measured on this application, production build, Next 16.2.12:
 *
 * | request                               | script tags | nonced |
 * | ------------------------------------- | ----------- | ------ |
 * | `/` (static)                          | 18          | 0      |
 * | `/blog` (ISR, prerendered)            | 24          | 0      |
 * | `/dashboard` (PPR shell + dynamic)    | 20 + 24     | 24     |
 * | `/blog/<unprerendered slug>` (ISR miss)| 17         | 17     |
 * | `/` in dev (always rendered)          | 36          | 36     |
 *
 * So on a production build of *this* repository — where every route is `○` or
 * `◐` and the shell always comes off disk — the document's own scripts carry no
 * nonce, and only the request-time part of a PPR route does.
 *
 * ## Why there is no `'strict-dynamic'`
 *
 * The spec item asked for one. `'strict-dynamic'` makes a browser *ignore*
 * every host source in `script-src` — `'self'` included — and allow only
 * scripts carrying the nonce or a matching hash, plus whatever those scripts
 * insert themselves. Every prerendered document here loads its chunk graph
 * through 13–18 parser-inserted `<script src="/_next/static/…">` tags with no
 * nonce on them, because of the measurement above. Adding `'strict-dynamic'`
 * therefore blocks the entire bundle on every prerendered route: the HTML
 * paints, nothing hydrates, and `next build` stays green because no gate looks
 * at a browser. `scripts/assert-csp.ts` fails on it for that reason, and
 * `docs/csp.md` records the browser run that measured it.
 *
 * The alternative to dropping it would be dropping prerendering — a nonce-only
 * policy is exactly right for an application that server-renders every
 * document, and that is not this one: `/`, `/blog`, `/login`, `/register`,
 * `/forbidden`, `/photos` and `/pricing` are static, `/blog/[slug]` is ISR, and
 * `scripts/assert-route-shape.ts` fails the build if any of that changes.
 *
 * ## What replaces it
 *
 * Two sources instead of one, covering the two halves of a PPR response:
 *
 *  - **`'nonce-…'`**, minted per request in `src/proxy.ts`, covers everything
 *    rendered during the request: the streamed flight payload of every dynamic
 *    hole, an ISR page generated on demand, a route that becomes dynamic later,
 *    and the whole document in `next dev`.
 *  - **`'sha256-…'`**, one per inline script in the *prerendered* document,
 *    emitted by `scripts/emit-csp-hashes.ts` from the build output and read at
 *    request time by `@/lib/security/shell-hashes`. A hash is bound to the
 *    bytes it names, so unlike a build-time nonce — which would be public,
 *    identical for every visitor, and therefore `'unsafe-inline'` with extra
 *    steps — it authorises that exact script and nothing else.
 *
 * Neither source can cover the third case, which took a second measurement to
 * find: a document Next **re-renders at runtime and caches** — an ISR route. The
 * digests describe what the build wrote, and a revalidation writes something
 * else; a nonce is worse, because Next bakes the triggering request's nonce into
 * the stored HTML and serves it to everyone after. Those paths get
 * `'self' 'unsafe-inline'` for scripts and nothing else changed, and the nonce is
 * withheld from them entirely. See `PolicyInput.documentRegenerates`.
 *
 * `'unsafe-inline'` appears nowhere else, and cannot: a policy carrying a nonce
 * or a hash makes a CSP3 browser ignore it anyway, so beside either one it would
 * be a word that reads like a fallback and does nothing.
 *
 * Everything here is a pure function of its inputs — no `process.env`, no
 * request — so `scripts/assert-csp.ts` can build the same policy the proxy
 * builds and hold it against the documents the build wrote.
 */
import {
  THIRD_PARTIES,
  selectActiveScripts,
  type ThirdPartyConfig,
} from "@/lib/third-party/catalogue";

/** The enforcing header. Also the one Next reads the nonce out of. */
export const CSP_HEADER = "content-security-policy";

/**
 * The reporting header, used for staged rollout.
 *
 * Next reads the nonce from this one too, so a report-only deployment still
 * gets nonced markup — the policy is complete and enforced by nobody, which is
 * the point of the mode.
 */
export const CSP_REPORT_ONLY_HEADER = "content-security-policy-report-only";

/** Where a Server Component or route handler reads the nonce for this request. */
export const NONCE_HEADER = "x-nonce";

/**
 * Headers the proxy owns end to end.
 *
 * Stripped from every inbound request before anything is set, for the reason
 * `@/lib/experiments/edge` spells out at length: a header the proxy forwards is
 * indistinguishable, at the receiving end, from one the client sent. Left
 * un-stripped, `content-security-policy: script-src 'nonce-whatever-I-like'` on
 * an incoming request is read by `app-render` as the policy for that render, and
 * every script in the response comes back stamped with a value the caller chose
 * — which is the injection this whole file exists to prevent, handed over on
 * request. Verified against a running production server before it was fixed.
 */
export const INTERNAL_CSP_HEADERS = [
  CSP_HEADER,
  CSP_REPORT_ONLY_HEADER,
  NONCE_HEADER,
] as const;

/** Bytes of randomness per nonce. 128 bits, the value Next's own example uses. */
const NONCE_BYTES = 16;

/**
 * A fresh nonce.
 *
 * `crypto.getRandomValues` rather than `randomUUID`: a UUID is 122 bits of
 * randomness in a 36-character string with a fixed version nibble, and
 * base64-encoding one (the shape most examples use) sends 48 characters to say
 * it. This is 24 characters of base64 carrying 128 bits.
 *
 * Standard base64 — `+` and `/` are both in the character class Next's
 * `CSP_NONCE_SOURCE_REGEX` accepts, and in the CSP grammar's `base64-value`.
 */
export function mintNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  return btoa(String.fromCharCode(...bytes));
}

/** A `'sha256-…'` source, as `script-src` wants it written. */
export function hashSource(base64Digest: string): string {
  return `'sha256-${base64Digest}'`;
}

export interface PolicyInput {
  /**
   * This request's nonce, from `mintNonce`, or `undefined` for a document Next
   * may re-render and cache at runtime — see `documentRegenerates`.
   */
  readonly nonce: string | undefined;
  /**
   * Base64 sha-256 digests of the inline scripts in the document this request
   * will be answered with, when that document was prerendered. Empty for a
   * request whose document is rendered on demand — the nonce covers those.
   */
  readonly shellHashes?: readonly string[] | undefined;
  /**
   * `development` relaxes exactly two things, both of them properties of the
   * dev server rather than of this application: Turbopack's HMR client opens a
   * WebSocket, and React's dev build and the refresh runtime evaluate code from
   * strings. Neither is in a production bundle, and a production policy that
   * carried them would be permanently weaker to spare a local console warning.
   */
  readonly mode: "development" | "production";
  /**
   * Whether the request arrived over HTTPS, from `isSecureRequest`.
   *
   * Decides only `upgrade-insecure-requests`. Sending that on a plain-HTTP
   * request would rewrite the page's own subresource URLs to `https://` on a
   * server that is not serving TLS — which is `next start` on localhost, and
   * every container behind a terminating proxy while you exec into it.
   */
  readonly secure: boolean;
  /** Which third parties this deployment has configured. */
  readonly thirdParty: ThirdPartyConfig;
  /**
   * Whether the document answering this request may be re-rendered at runtime and
   * cached — an ISR route, in other words.
   *
   * This is the one case where neither mechanism works, and it took a measurement
   * to find:
   *
   *  - The digests describe what the *build* wrote, and a revalidation writes
   *    something else. `.next/server/app/blog.html` was rewritten seven minutes
   *    after the build that produced it, with eight inline scripts no digest in
   *    the manifest covered.
   *  - A nonce is actively harmful. Next renders the replacement using the
   *    headers of whichever request triggered the revalidation — nonce included —
   *    and stores the HTML with that nonce baked into every script tag. Two
   *    requests carrying different nonces were both answered with
   *    `nonce="OdpfD9ah6T/VpP8gezgfkA=="`, from a third request minutes earlier.
   *    Under an enforcing policy every visitor after the one that repopulated the
   *    cache is served a page whose scripts their own policy refuses.
   *
   * So for these paths `script-src` is `'self' 'unsafe-inline'`, with no nonce and
   * no digests — because a nonce or a digest in the same directive would make a
   * CSP3 browser *ignore* `'unsafe-inline'`, which is the same outage arrived at
   * by a longer route. Every other directive is unchanged and still enforced, so
   * an injected `<script src="https://…">`, an `<object>`, a rewritten `<base>`
   * and an off-origin form target are all still refused on these paths; what is
   * given up is inline script, on the routes whose HTML Next regenerates.
   *
   * The alternative is to stop caching whole documents — a dynamic document with
   * cached data, which `docs/csp.md` spells out — and that is an architectural
   * choice this item is not entitled to make on the application's behalf.
   */
  readonly documentRegenerates?: boolean | undefined;
}

/**
 * Third-party hosts, by the role the catalogue gives them.
 *
 * Read from `@/lib/third-party/catalogue` rather than listed again here, so that
 * adding an origin to the inventory is what permits it — one record, two
 * consumers, and `scripts/assert-csp.ts` fails if the policy and the catalogue
 * disagree. A host written into this file instead would be an origin the
 * browser may contact that the third-party audit has never seen.
 *
 * `**.googleusercontent.com` is the catalogue's spelling, which is
 * `next.config.ts`'s `remotePatterns` syntax. CSP wants one `*`.
 */
function originsFor(
  mode: "script" | "facade" | "asset",
  config: ThirdPartyConfig,
): string[] {
  const active =
    mode === "script"
      ? new Set(
          selectActiveScripts(config).map((script) => script.thirdParty.id),
        )
      : undefined;

  return THIRD_PARTIES.filter(
    (entry) =>
      entry.loading.mode === mode &&
      (active === undefined || active.has(entry.id)),
  ).flatMap((entry) =>
    entry.hosts.map((host) => `https://${host.replace(/^\*\*\./, "*.")}`),
  );
}

/** One directive, as a name and the sources that follow it. */
export interface Directive {
  readonly name: string;
  readonly sources: readonly string[];
}

/**
 * Every directive this application needs, in the order they are serialised.
 *
 * Exported as data so the gate can reason about a directive rather than about
 * substrings of a header value.
 */
export function directives(input: PolicyInput): Directive[] {
  const { nonce, mode, secure, thirdParty } = input;
  const dev = mode === "development";
  const regenerates = input.documentRegenerates === true;
  const shellHashes = regenerates ? [] : (input.shellHashes ?? []);

  const scriptSources = [
    // Kept, and load-bearing: the 13–18 `<script src="/_next/static/…">` tags
    // in every prerendered document are same-origin and carry no nonce. This is
    // the source that allows them, and the reason `'strict-dynamic'` — which
    // would make a browser ignore it — is not in this list.
    "'self'",
    // A nonce and a digest are both refusals on a document Next re-renders at
    // runtime; `'unsafe-inline'` is the only source that survives one. See
    // `documentRegenerates`. The two branches are exclusive on purpose: a nonce
    // or a hash alongside `'unsafe-inline'` makes a browser ignore the latter.
    ...(regenerates
      ? ["'unsafe-inline'"]
      : [
          ...(nonce !== undefined ? [`'nonce-${nonce}'`] : []),
          ...shellHashes.map(hashSource),
        ]),
    ...originsFor("script", thirdParty),
    // Turbopack's dev runtime and React's development build evaluate module
    // code from strings. Production has neither.
    ...(dev ? ["'unsafe-eval'"] : []),
  ];

  return [
    { name: "default-src", sources: ["'self'"] },
    { name: "script-src", sources: scriptSources },
    {
      name: "style-src",
      // The one `'unsafe-inline'` in this policy, and it is about attributes
      // rather than scripts. React renders `style={{…}}` as a `style` attribute
      // — 30 of them on a blog post — and an attribute has no nonce to carry;
      // `next-themes`' `disableTransitionOnChange` appends a `<style>` element
      // from the client, in a prerendered document, where a per-request nonce
      // cannot reach it either. Neither can execute code: `style-src` governs
      // CSS, and `script-src` above forbids inline script outright. Splitting
      // this into `style-src-elem`/`style-src-attr` would let the element half
      // be `'self'`-only and is deliberately not done — Safari shipped
      // `style-src-elem` late enough that the split silently means
      // "no inline styles at all" on older versions, which is a broken page in
      // exchange for a directive that reads stricter.
      sources: ["'self'", "'unsafe-inline'"],
    },
    // Self-hosted, via next/font. See docs/fonts.md.
    { name: "font-src", sources: ["'self'"] },
    {
      name: "img-src",
      sources: [
        "'self'",
        // next/image's blur placeholders are inlined as data URLs.
        "data:",
        // The upload form previews the selected file from an object URL before
        // anything is sent. See src/components/upload.
        "blob:",
        ...originsFor("asset", thirdParty),
      ],
    },
    {
      name: "connect-src",
      sources: [
        "'self'",
        // The analytics script posts events to its own origin.
        ...originsFor("script", thirdParty),
        // Turbopack's HMR socket. The exact origin is the dev server's own host
        // and port, which this module has no way to know and no reason to.
        ...(dev ? ["ws:", "wss:"] : []),
      ],
    },
    // The video facade's iframe, mounted on the first press and not before.
    {
      name: "frame-src",
      sources: ["'self'", ...originsFor("facade", thirdParty)],
    },
    // Nothing here is embeddable. This is the header-level half of what
    // `X-Frame-Options: DENY` used to say, and the half browsers still honour.
    { name: "frame-ancestors", sources: ["'none'"] },
    // No plugins, ever. `object-src 'none'` is the single highest-value
    // directive after `script-src` — Flash is gone but `<embed>` is not.
    { name: "object-src", sources: ["'none'"] },
    // Stops an injected `<base href>` from re-pointing every relative URL in
    // the document, including the ones that load the application's own chunks.
    { name: "base-uri", sources: ["'none'"] },
    // Server Actions and the NextAuth endpoints are all same-origin. An OAuth
    // sign-in leaves through a 302, which is a navigation and not a form post.
    { name: "form-action", sources: ["'self'"] },
    ...(secure
      ? [{ name: "upgrade-insecure-requests", sources: [] as string[] }]
      : []),
  ];
}

/** The header value: directives joined by `; `, sources by a space. */
export function serialise(list: readonly Directive[]): string {
  return list
    .map(({ name, sources }) =>
      sources.length === 0 ? name : `${name} ${sources.join(" ")}`,
    )
    .join("; ");
}

export function buildPolicy(input: PolicyInput): string {
  return serialise(directives(input));
}

/**
 * A policy header value, back into directives.
 *
 * Here because the gate and the tests need to answer "would a browser allow
 * this script tag?", and doing that against a string is how a check ends up
 * asserting that a substring is present rather than that a document loads.
 */
export function parsePolicy(value: string): Map<string, string[]> {
  const parsed = new Map<string, string[]>();

  for (const directive of value.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name === undefined || name === "") continue;
    parsed.set(name.toLowerCase(), sources);
  }

  return parsed;
}

/**
 * The sources that decide script execution, with CSP's fallback applied.
 *
 * `script-src-elem` wins over `script-src`, which wins over `default-src`.
 * Returns `undefined` when none of them is present, which means "not
 * restricted" and is a different answer from "restricted to nothing".
 */
export function scriptSources(
  policy: Map<string, string[]>,
): string[] | undefined {
  return (
    policy.get("script-src-elem") ??
    policy.get("script-src") ??
    policy.get("default-src")
  );
}

/**
 * Whether a policy would let a same-origin `<script src>` tag execute.
 *
 * Only the two cases this codebase can produce are modelled: a same-origin path
 * (`/_next/static/…`) and an absolute URL on a third-party origin. The
 * `'strict-dynamic'` branch is the interesting one — it is what makes the gate
 * able to prove that adding the keyword breaks the prerendered documents,
 * rather than asserting that the keyword is absent because a comment says so.
 */
export function allowsExternalScript(
  policy: Map<string, string[]>,
  url: string,
  options: { readonly nonce?: string | undefined } = {},
): boolean {
  const sources = scriptSources(policy);
  if (sources === undefined) return true;
  if (
    options.nonce !== undefined &&
    sources.includes(`'nonce-${options.nonce}'`)
  )
    return true;

  // Every host source is ignored once `'strict-dynamic'` is present, so a
  // parser-inserted tag with no nonce and no matching hash is refused.
  if (sources.includes("'strict-dynamic'")) return false;

  const sameOrigin = url.startsWith("/");
  if (sameOrigin) return sources.includes("'self'");

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }

  return sources.some((source) => matchesOrigin(source, origin));
}

/**
 * `https://plausible.io` against `'self'`, a literal origin, or `https://*.host`.
 *
 * The wildcard keeps the leading dot when it is compared — `*.example.com` is a
 * subdomain wildcard, and dropping the dot would make it match
 * `notexample.com`, which is a different registrable domain and somebody else's.
 */
function matchesOrigin(source: string, origin: string): boolean {
  if (source.startsWith("'")) return false;
  if (source === origin) return true;

  const wildcard = "https://*";
  if (!source.startsWith(`${wildcard}.`)) return false;
  if (!origin.startsWith("https://")) return false;

  const suffix = source.slice(wildcard.length);
  return origin.slice("https://".length).endsWith(suffix);
}

/**
 * Whether a policy would let an inline `<script>` with this digest execute.
 *
 * `nonce` is the attribute the *tag* carries, which is not the same question as
 * whether the policy contains a nonce: a prerendered document's inline scripts
 * carry none, and that is the case the hashes exist for.
 */
export function allowsInlineScript(
  policy: Map<string, string[]>,
  digest: string,
  options: { readonly nonce?: string | undefined } = {},
): boolean {
  const sources = scriptSources(policy);
  if (sources === undefined) return true;
  if (
    options.nonce !== undefined &&
    sources.includes(`'nonce-${options.nonce}'`)
  )
    return true;
  if (sources.includes(hashSource(digest))) return true;

  // Ignored by any browser that understands the nonce or hash sources this
  // policy always carries, so it is never the reason a script runs here.
  const hasNonceOrHash = sources.some(
    (source) =>
      source.startsWith("'nonce-") ||
      source.startsWith("'sha256-") ||
      source.startsWith("'sha384-") ||
      source.startsWith("'sha512-"),
  );

  return !hasNonceOrHash && sources.includes("'unsafe-inline'");
}
