/**
 * Emits the sha-256 digests of the inline scripts in every prerendered document.
 *
 * ## Why this exists at all
 *
 * A Content Security Policy that forbids `'unsafe-inline'` has to name every
 * inline script it allows, by nonce or by hash. Next stamps a nonce on markup it
 * renders *during a request* and cannot stamp one on a document it prerendered
 * at build time — the request did not exist then. On a production build of this
 * application every document is prerendered (`○` or `◐`), so the document's own
 * inline scripts have no nonce and never will, and the only sound way to
 * authorise them is to hash the bytes the build wrote.
 *
 * That is what this does: it reads the HTML `next build` just emitted, hashes
 * every inline `<script>` in it, and writes the digests to
 * `.next/csp-shell-hashes.json`, which `@/lib/security/shell-hashes` reads once
 * per process at runtime. The full argument, and the measurements behind it, are
 * in `docs/csp.md` and at the top of `@/lib/security/csp`.
 *
 * It runs *after* the build and writes into the build directory rather than into
 * `src/`, for two reasons. A committed list would be stale the moment anyone
 * edited a page — the digests cover the flight payload, which contains the
 * page's own markup — and turning it into a source file would mean building
 * twice, with the second build's chunk names potentially changing the very
 * bytes the first build's hashes describe.
 *
 * Usage: tsx scripts/emit-csp-hashes.ts [path-to-.next]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  MANIFEST_FILE,
  MANIFEST_VERSION,
  type DynamicShell,
  type ShellEntry,
  type ShellHashManifest,
} from "@/lib/security/shell-hashes";

/**
 * Documents that can be served in answer to a path that has no entry of its own.
 *
 * A 404 is rendered for whatever URL missed, and a 500 for whatever URL threw,
 * so neither can be looked up by path. Their digests go on every response.
 */
export const UNIVERSAL_DOCUMENTS = ["/_not-found", "/_global-error"] as const;

/** A prerendered document: the route it answers, and its HTML. */
export interface PrerenderedDocument {
  /** Route as the build names the file, e.g. `/blog/[slug]` or `/(.)photos/[id]`. */
  readonly route: string;
  readonly html: string;
}

/**
 * Every inline script's content, in document order.
 *
 * A tag with a `src` is not inline — it is fetched, and `'self'` or a host
 * source is what allows it. The non-greedy body match is safe against a
 * `</script>` inside a JavaScript string because the HTML spec requires that to
 * be escaped and React escapes it (`<\/script>`), which is also why the browser
 * and this script see the same bytes.
 *
 * The bytes are what matters: a browser hashes the element's text content
 * exactly as it appears in the source, with no entity decoding and no
 * whitespace normalisation. So this must not trim.
 */
export function inlineScripts(html: string): string[] {
  const bodies: string[] = [];
  const pattern = /<script([^>]*)>([\s\S]*?)<\/script>/g;

  for (const match of html.matchAll(pattern)) {
    const attributes = match[1] ?? "";
    if (/\bsrc\s*=/.test(attributes)) continue;
    const body = match[2] ?? "";
    if (body === "") continue;
    bodies.push(body);
  }

  return bodies;
}

/** Base64 sha-256, the digest half of a `'sha256-…'` source. */
export function digest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("base64");
}

/** Every inline script in a document, hashed and de-duplicated. */
export function documentHashes(html: string): string[] {
  return [...new Set(inlineScripts(html).map(digest))];
}

/**
 * The path a document is served at, with route-group and interception markers
 * removed.
 *
 * `(auth)` and `(dashboard)` never reach the build output — Next resolves groups
 * into the paths beneath them — but `(.)photos/[id]` does, because an
 * interception route is a distinct entry in the manifest. It is served at
 * `/photos/[id]`, so its digests belong to that path: a hard navigation renders
 * the page's own document and a soft one renders the interception, and which
 * arrives depends on how the visitor got there, not on anything visible here.
 */
export function servedPath(route: string): string {
  const segments: string[] = [];

  for (const segment of route.split("/")) {
    // `(.)photos` — an interception marker glued to the segment it intercepts.
    // The marker repeats for each level it reaches up (`(..)(..)photos`), so the
    // group is quantified rather than matched once.
    const intercepted = /^(?:\(\.{1,3}\))+(.+)$/.exec(segment);
    if (intercepted?.[1] !== undefined) {
      segments.push(intercepted[1]);
      continue;
    }
    // `(auth)` — a route group, which contributes nothing to the URL.
    if (/^\(.*\)$/.test(segment)) continue;
    segments.push(segment);
  }

  const joined = segments.join("/");
  return joined === "" ? "/" : joined;
}

/** Whether a route is a dynamic-route fallback shell rather than a fixed path. */
export function isDynamicRoute(route: string): boolean {
  return route.includes("[");
}

/**
 * The regex that decides whether a request path is served by a dynamic route.
 *
 * Taken from the prerender manifest when the build recorded one, because that is
 * the expression Next itself matches with. Derived from the route pattern only
 * as a fallback, for a route the manifest has no entry for — an interception
 * route whose served path is not itself dynamic, for instance.
 */
export function routeRegex(
  route: string,
  fromManifest: Readonly<Record<string, string>>,
): string {
  const recorded = fromManifest[route];
  if (recorded !== undefined) return recorded;

  const pattern = route
    .split("/")
    .map((segment) => {
      if (/^\[\[?\.\.\./.test(segment)) return "(.+?)";
      if (segment.startsWith("[")) return "([^/]+?)";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    })
    .join("/");

  return `^${pattern}(?:/)?$`;
}

/**
 * The routes Next may re-render at runtime, from the prerender manifest.
 *
 * `initialRevalidateSeconds` is a number for a route with a revalidation window
 * and `false` otherwise, and that is the whole test — measured on this build:
 * of 31 prerendered documents, only `/blog` (60s) and `/blog/[slug]` (300s)
 * carry one, and only `blog.html` was rewritten at runtime, seven minutes after
 * the build. Read from the manifest rather than from a list in source so that
 * adding `export const revalidate` to a page is what moves that page onto the
 * relaxed policy, with no second place to remember.
 *
 * Keyed by the route as the manifest spells it. A dynamic route's window lives
 * under the route pattern, a prerendered instance's under its own path, so both
 * shapes are here and the lookup tries the served path first.
 */
export function revalidatingRoutes(manifest: unknown): Set<string> {
  const routes = new Set<string>();
  if (typeof manifest !== "object" || manifest === null) return routes;

  const record = manifest as Record<string, unknown>;

  for (const key of ["routes", "dynamicRoutes"]) {
    const group = record[key];
    if (typeof group !== "object" || group === null) continue;

    for (const [route, entry] of Object.entries(group)) {
      if (typeof entry !== "object" || entry === null) continue;
      const window = (entry as Record<string, unknown>)[
        "initialRevalidateSeconds"
      ];
      if (typeof window === "number") routes.add(route);
    }
  }

  return routes;
}

/** `routeRegex` per dynamic route, from `.next/prerender-manifest.json`. */
export function dynamicRouteRegexes(manifest: unknown): Record<string, string> {
  const regexes: Record<string, string> = {};
  if (typeof manifest !== "object" || manifest === null) return regexes;

  const dynamic = (manifest as Record<string, unknown>)["dynamicRoutes"];
  if (typeof dynamic !== "object" || dynamic === null) return regexes;

  for (const [route, entry] of Object.entries(dynamic)) {
    if (typeof entry !== "object" || entry === null) continue;
    const recorded = (entry as Record<string, unknown>)["routeRegex"];
    if (typeof recorded === "string") regexes[route] = recorded;
  }

  return regexes;
}

/**
 * Builds the manifest from the documents the build wrote.
 *
 * Pure, so the tests can describe a build output — including a document whose
 * inline scripts changed between two builds — without running one.
 */
export function buildManifest(
  documents: readonly PrerenderedDocument[],
  options: {
    readonly buildId: string;
    readonly regexes?: Readonly<Record<string, string>>;
    /** Routes with a revalidation window, from `revalidatingRoutes`. */
    readonly revalidating?: ReadonlySet<string>;
  },
): ShellHashManifest {
  const regexes = options.regexes ?? {};
  const revalidating = options.revalidating ?? new Set<string>();
  const universal = new Set<string>();
  const exact = new Map<
    string,
    { hashes: Set<string>; regenerates: boolean }
  >();
  const dynamic = new Map<
    string,
    { route: string; hashes: Set<string>; regenerates: boolean }
  >();

  for (const document of documents) {
    const hashes = documentHashes(document.html);

    if ((UNIVERSAL_DOCUMENTS as readonly string[]).includes(document.route)) {
      for (const hash of hashes) universal.add(hash);
      continue;
    }

    const served = servedPath(document.route);
    // Either spelling can carry the window: a prerendered instance records it
    // under its own path, a fallback shell under the route pattern.
    const regenerates =
      revalidating.has(served) || revalidating.has(document.route);

    if (isDynamicRoute(served)) {
      // Keyed on the *served* path, not the build's name for the route. The
      // manifest records `/(.)photos/[id]`'s regex as
      // `^/\(\.\)photos/([^/]+?)(?:/)?$`, which no request path can ever match —
      // the parentheses are a file-system convention, and the interception is
      // served at `/photos/[id]`. Resolving the served path is also what merges
      // the interception's digests into the page's own entry.
      const regex = routeRegex(served, regexes);
      const existing = dynamic.get(regex) ?? {
        route: served,
        hashes: new Set<string>(),
        regenerates: false,
      };
      for (const hash of hashes) existing.hashes.add(hash);
      dynamic.set(regex, {
        ...existing,
        // The stricter of the two: one document behind this pattern being
        // regenerated is enough to make a digest-based policy unsafe for it.
        regenerates: existing.regenerates || regenerates,
      });
      continue;
    }

    const existing = exact.get(served) ?? {
      hashes: new Set<string>(),
      regenerates: false,
    };
    for (const hash of hashes) existing.hashes.add(hash);
    exact.set(served, {
      hashes: existing.hashes,
      regenerates: existing.regenerates || regenerates,
    });
  }

  return {
    version: MANIFEST_VERSION,
    buildId: options.buildId,
    universal: [...universal],
    // Sorted so two builds of the same tree produce the same file and a diff of
    // the manifest is a diff of the digests rather than of readdir order.
    exact: Object.fromEntries(
      [...exact.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([route, entry]): [string, ShellEntry] => [
          route,
          { hashes: [...entry.hashes], regenerates: entry.regenerates },
        ]),
    ),
    dynamic: [...dynamic.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([regex, { route, hashes, regenerates }]): DynamicShell => ({
        route,
        regex,
        hashes: [...hashes],
        regenerates,
      })),
  };
}

/**
 * Reads every prerendered document out of a build directory.
 *
 * `.next/server/app` is where the App Router writes them, one `.html` per
 * prerendered route plus one per dynamic route's fallback shell. Anything else
 * in there — `.rsc` payloads, `.meta` files, the route modules — is not a
 * document and has no inline script a browser will execute.
 */
export function readPrerenderedDocuments(
  nextDir: string,
): PrerenderedDocument[] {
  const root = path.join(nextDir, "server", "app");
  const documents: PrerenderedDocument[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".html")) continue;

      const relative = path.relative(root, full).replace(/\.html$/, "");
      const route = relative === "index" ? "/" : `/${relative}`;
      documents.push({ route, html: readFileSync(full, "utf8") });
    }
  };

  walk(root);
  return documents;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function readBuildId(nextDir: string): string {
  try {
    return readFileSync(path.join(nextDir, "BUILD_ID"), "utf8").trim();
  } catch {
    return "unknown";
  }
}

function main(argv: readonly string[]): number {
  const nextDir = argv[0] ?? ".next";
  const documents = readPrerenderedDocuments(nextDir);

  if (documents.length === 0) {
    console.error(
      `No prerendered documents under ${path.join(nextDir, "server", "app")}.\n` +
        "Run `next build` first: this reads the HTML the build wrote, and a policy\n" +
        "emitted from no documents would authorise nothing.\n",
    );
    return 1;
  }

  const prerenderManifest = readJson(
    path.join(nextDir, "prerender-manifest.json"),
  );

  const manifest = buildManifest(documents, {
    buildId: readBuildId(nextDir),
    regexes: dynamicRouteRegexes(prerenderManifest),
    revalidating: revalidatingRoutes(prerenderManifest),
  });

  const target = path.join(nextDir, MANIFEST_FILE);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const counted =
    manifest.universal.length +
    Object.values(manifest.exact).reduce(
      (sum, entry) => sum + entry.hashes.length,
      0,
    ) +
    manifest.dynamic.reduce((sum, shell) => sum + shell.hashes.length, 0);

  const regenerating = [
    ...Object.entries(manifest.exact)
      .filter(([, entry]) => entry.regenerates)
      .map(([route]) => route),
    ...manifest.dynamic
      .filter((shell) => shell.regenerates)
      .map((shell) => shell.route),
  ];

  console.log(
    `Wrote ${path.relative(process.cwd(), target)} — ${counted} digest(s) from ` +
      `${documents.length} prerendered document(s): ` +
      `${Object.keys(manifest.exact).length} exact path(s), ` +
      `${manifest.dynamic.length} dynamic shell(s), ` +
      `${manifest.universal.length} universal. ` +
      (regenerating.length === 0
        ? "No route is re-rendered at runtime."
        : `Re-rendered at runtime, so digests cannot cover them: ${regenerating.join(", ")}.`),
  );
  return 0;
}

/* c8 ignore start -- CLI entry; the logic above is what the tests exercise. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
