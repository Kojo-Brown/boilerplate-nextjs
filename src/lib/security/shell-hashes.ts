/**
 * The hashes of the inline scripts in a prerendered document, at request time.
 *
 * ## Why this is read from the build output instead of written down
 *
 * A prerendered document's inline scripts are Next's own: one bootstrap line
 * (`(self.__next_f=self.__next_f||[]).push([0])`), the flight payload of
 * everything the page rendered at build time, and `next-themes`' pre-paint
 * theme script. Their *content* therefore contains chunk filenames and the
 * page's own markup, so it changes whenever anything on the page changes —
 * across the 30 documents this application prerenders there are 183 of them and
 * 94 distinct digests.
 *
 * That rules out a committed list: it would go stale on a copy edit, and the
 * failure would be a page that paints and never hydrates. It also rules out
 * computing the hashes in the proxy, which never sees the document. So the
 * build emits them — `scripts/emit-csp-hashes.ts` reads the HTML `next build`
 * just wrote — and this module reads that file once per process and resolves a
 * request path against it.
 *
 * ## The three shapes a lookup has to cover
 *
 *  - **An exact path.** `/`, `/blog`, `/pricing/v/control`: a document on disk
 *    at a known path.
 *  - **A dynamic route's fallback shell.** `/blog/[slug]` has a shell of its own
 *    that is served for slugs the build did not enumerate, so the lookup falls
 *    back to the route's regex from the prerender manifest.
 *  - **Any path at all.** `_not-found` and `_global-error` are documents that
 *    can be served in answer to a URL that matches nothing, which by definition
 *    has no entry of its own. Their hashes are `universal` and go on every
 *    response: ~9 digests, about 500 bytes of header, and without them a 404 is
 *    a page whose scripts the policy refuses.
 *
 * A miss is not an error. `next dev` prerenders nothing, renders every document
 * on demand and nonces all of it, so there is no manifest and none is needed;
 * the same is true of a path served by an on-demand ISR render. What *is* an
 * error is a production server with no manifest at all — the build step that
 * emits it did not run — and that case is reported loudly and degrades to
 * report-only in `@/lib/security/apply` rather than serving an application whose
 * scripts are all refused.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** The file `scripts/emit-csp-hashes.ts` writes, inside the build directory. */
export const MANIFEST_FILE = "csp-shell-hashes.json";

/** Current manifest shape. Bumped if the layout below ever changes. */
export const MANIFEST_VERSION = 1;

export interface ShellEntry {
  /** Digests of the inline scripts in the document the build wrote. */
  readonly hashes: readonly string[];
  /**
   * Whether Next may re-render this document at runtime and cache the result.
   *
   * True for a route with a revalidation window. Both halves of the strict
   * policy fail on such a document, which is why this flag exists rather than
   * being inferred from something else:
   *
   *  - The digests describe the bytes the *build* wrote. A revalidation writes
   *    new bytes — measured: `.next/server/app/blog.html` was rewritten 7
   *    minutes after the build — and nothing recomputes the manifest.
   *  - A nonce is worse than useless. The render that repopulates the cache
   *    takes the nonce off *that one request* and Next stores the HTML with it
   *    baked in, so every visitor afterwards is served a document whose scripts
   *    carry a nonce their own policy does not contain. Measured on this
   *    application: two requests with different nonces were both answered with
   *    `nonce="OdpfD9ah6T/VpP8gezgfkA=="`, the nonce of some earlier request.
   *
   * See `buildPolicy` for what the policy does with it, and docs/csp.md for the
   * measurements in full.
   */
  readonly regenerates: boolean;
}

export interface DynamicShell extends ShellEntry {
  /** The route as the app router spells it, e.g. `/blog/[slug]`. */
  readonly route: string;
  /** `routeRegex` from the prerender manifest, as a source string. */
  readonly regex: string;
}

export interface ShellHashManifest {
  readonly version: number;
  /** The build this was emitted for. Printed on a mismatch, never trusted. */
  readonly buildId: string;
  /** Hashes that go on every response. See the note above. */
  readonly universal: readonly string[];
  /** Concrete document paths, e.g. `/blog/seed-post-cache-life`. */
  readonly exact: Readonly<Record<string, ShellEntry>>;
  /** Fallback shells, tried in order when no exact entry matches. */
  readonly dynamic: readonly DynamicShell[];
}

/**
 * Validates a parsed manifest without pulling a schema library in.
 *
 * Zod is already a dependency and this would be four lines with it. It is not
 * used here on purpose: this module is imported by `src/proxy.ts`, which runs
 * before everything else on every request, and the one thing it needs from a
 * build artefact it wrote itself is a shape check. The rate limiter's store and
 * the experiment registry are in that bundle for the same reason — the proxy's
 * module graph is kept to what it cannot do without.
 */
export function parseManifest(value: unknown): ShellHashManifest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;

  const isStringArray = (input: unknown): input is string[] =>
    Array.isArray(input) && input.every((entry) => typeof entry === "string");

  if (candidate["version"] !== MANIFEST_VERSION) return undefined;
  if (typeof candidate["buildId"] !== "string") return undefined;
  if (!isStringArray(candidate["universal"])) return undefined;

  const readEntry = (value: unknown): ShellEntry | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    const entry = value as Record<string, unknown>;
    if (!isStringArray(entry["hashes"])) return undefined;
    if (typeof entry["regenerates"] !== "boolean") return undefined;
    return { hashes: entry["hashes"], regenerates: entry["regenerates"] };
  };

  const exactRaw = candidate["exact"];
  if (typeof exactRaw !== "object" || exactRaw === null) return undefined;
  const exact: Record<string, ShellEntry> = {};
  for (const [key, value] of Object.entries(exactRaw)) {
    const entry = readEntry(value);
    if (entry === undefined) return undefined;
    exact[key] = entry;
  }

  const dynamicRaw = candidate["dynamic"];
  if (!Array.isArray(dynamicRaw)) return undefined;
  const dynamic: DynamicShell[] = [];
  for (const value of dynamicRaw) {
    const entry = readEntry(value);
    if (entry === undefined) return undefined;
    const shell = value as Record<string, unknown>;
    if (typeof shell["route"] !== "string") return undefined;
    if (typeof shell["regex"] !== "string") return undefined;
    dynamic.push({
      route: shell["route"],
      regex: shell["regex"],
      hashes: entry.hashes,
      regenerates: entry.regenerates,
    });
  }

  return {
    version: MANIFEST_VERSION,
    buildId: candidate["buildId"],
    universal: candidate["universal"],
    exact,
    dynamic,
  };
}

/**
 * What the policy for this request needs to know about the document behind it.
 *
 * `served` is the path whose *document* will be answered with, which is not
 * always the path that was requested: `/pricing` is rewritten to
 * `/pricing/v/control` for the control arm, and it is the variant's document
 * that gets served. Both are looked up, the digests are unioned — a hash
 * authorises the bytes it names and nothing else, so an extra one costs header
 * length and no safety, while a missing one costs a page — and `regenerates` is
 * the *or* of the two, because a strict policy is only safe when every document
 * that could answer this request is fixed.
 *
 * A trailing slash is normalised away because `NextResponse.rewrite` preserves
 * whatever the browser sent and the manifest is keyed the way the build names
 * its files.
 */
export function resolveShell(
  manifest: ShellHashManifest,
  requested: string,
  served?: string | undefined,
): ShellEntry {
  const paths = [requested, ...(served !== undefined ? [served] : [])];
  const hashes = new Set<string>(manifest.universal);
  let regenerates = false;

  for (const candidate of paths) {
    const pathname = normalise(candidate);
    const exact = manifest.exact[pathname];

    if (exact !== undefined) {
      for (const hash of exact.hashes) hashes.add(hash);
      regenerates ||= exact.regenerates;
      continue;
    }

    for (const shell of manifest.dynamic) {
      if (!safeTest(shell.regex, pathname)) continue;
      for (const hash of shell.hashes) hashes.add(hash);
      regenerates ||= shell.regenerates;
      // No `break`: two dynamic routes can match one path — `/photos/[id]` and
      // the `(.)photos/[id]` interception both answer `/photos/ocean-at-sunset`
      // — and which document is served depends on how the visitor got there.
    }
  }

  return { hashes: [...hashes], regenerates };
}

function normalise(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/"))
    return pathname.slice(0, -1);
  return pathname;
}

/**
 * The regex comes from a file this build wrote, and is still compiled
 * defensively: a `RegExp` constructor throwing inside the proxy would turn a
 * malformed artefact into a 500 on every request, and the honest answer to an
 * unreadable manifest is the report-only fallback, not an outage.
 */
function safeTest(source: string, pathname: string): boolean {
  try {
    return new RegExp(source).test(pathname);
  } catch {
    return false;
  }
}

/** Where the manifest lives, given a build directory. */
export function manifestPath(nextDir: string): string {
  return path.join(nextDir, MANIFEST_FILE);
}

/** Resolved once per process: the manifest, or the fact that there is none. */
let cached: { readonly manifest: ShellHashManifest | undefined } | undefined;

export interface LoadOptions {
  /** Build directory. `.next` relative to the working directory by default. */
  readonly nextDir?: string;
  /** Injected in tests; the default reads the file synchronously, once. */
  readonly read?: (file: string) => string;
}

/**
 * Loads and caches the manifest.
 *
 * One synchronous read at the first request of the process. `readFileSync` in a
 * request path is normally the wrong instinct, and it is the right one here: the
 * file is ~8 KB, it is read exactly once, and the alternative — an async read —
 * would let a burst of first requests each start their own before any finished,
 * for a file that never changes while the process lives.
 */
export function loadManifest(
  options: LoadOptions = {},
): ShellHashManifest | undefined {
  if (cached !== undefined) return cached.manifest;

  const nextDir = options.nextDir ?? path.join(process.cwd(), ".next");
  const read = options.read ?? ((file: string) => readFileSync(file, "utf8"));

  let manifest: ShellHashManifest | undefined;
  try {
    manifest = parseManifest(JSON.parse(read(manifestPath(nextDir))));
  } catch {
    manifest = undefined;
  }

  cached = { manifest };
  return manifest;
}

/** Drops the cached read. Exported for tests; nothing in the app calls it. */
export function resetManifestCache(): void {
  cached = undefined;
}
