/**
 * Asserts that the Content Security Policy would let this build's own documents
 * run.
 *
 * ## Why a gate, and why this shape
 *
 * Every other property of a CSP is checkable by reading the header. Whether the
 * application still *works* under it is not: a policy that refuses the bundle
 * produces a build that exits 0, unit tests that all pass, HTML that paints, and
 * a page where nothing hydrates — no error on the server, nothing in any
 * manifest, and a browser console nobody in CI is looking at. That is the same
 * failure shape as the unstyled-for-weeks stylesheet this repository already has
 * a gate for, and it is worse here, because the thing that breaks it is a
 * one-word edit to a policy that reads *stricter* afterwards.
 *
 * So this gate does what a browser does. It reads every prerendered document,
 * builds the policy the proxy would build for that document's path — from the
 * same pure module the proxy uses, with the digests `emit-csp-hashes.ts` wrote —
 * and checks each `<script>` in it against that policy, inline and external. A
 * `'strict-dynamic'` added to `@/lib/security/csp` fails rule 2 on all 30
 * documents with the count of scripts it would have blocked, rather than passing
 * because nothing looked.
 *
 * Checked against the failures it names, on this build:
 *
 *  - `'strict-dynamic'` added to `script-src` → 451 external script tags
 *    refused across 30 documents.
 *  - the emit step skipped → rule 3, no manifest for this build id.
 *  - one digest removed from the manifest → rule 1, naming the document.
 *  - `object-src` dropped → rule 5.
 *
 * Usage: tsx scripts/assert-csp.ts [path-to-.next]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  allowsExternalScript,
  allowsInlineScript,
  buildPolicy,
  parsePolicy,
} from "@/lib/security/csp";
import {
  MANIFEST_FILE,
  parseManifest,
  resolveShell,
  type ShellHashManifest,
} from "@/lib/security/shell-hashes";
import { THIRD_PARTIES } from "@/lib/third-party/catalogue";
import {
  collectSources,
  resolveSpecifier,
  type SourceFile,
} from "./assert-react-compiler";
import {
  digest,
  inlineScripts,
  readBuildId,
  readPrerenderedDocuments,
  revalidatingRoutes,
  servedPath,
  type PrerenderedDocument,
} from "./emit-csp-hashes";

export interface Violation {
  problem: string;
  because: string;
}

/**
 * A stand-in for a dynamic segment, used to look a fallback shell up the way a
 * request would.
 *
 * The manifest keys dynamic shells by the regex Next matches paths with, so
 * looking one up as the literal `/blog/[slug]` would find nothing and prove
 * nothing. Substituting a value makes the lookup take the same route a visitor's
 * URL takes, which is what fails if the regex is wrong.
 */
export const DYNAMIC_SEGMENT_PROBE = "csp-gate-probe";

/** Directives whose absence is invisible until it is exploited. */
export const REQUIRED_DIRECTIVES: readonly {
  name: string;
  sources: readonly string[];
  because: string;
}[] = [
  {
    name: "default-src",
    sources: ["'self'"],
    because:
      "the fallback every fetch directive this policy does not name falls back to",
  },
  {
    name: "object-src",
    sources: ["'none'"],
    because:
      "`<embed>` and `<object>` are still implemented, still execute, and are covered by no " +
      "other directive here — this is the highest-value line in the policy after `script-src`",
  },
  {
    name: "base-uri",
    sources: ["'none'"],
    because:
      "an injected `<base href>` re-points every relative URL in the document, including the " +
      "`/_next/static/…` chunks — which turns a markup injection into full script control " +
      "without ever writing a `<script>` tag",
  },
  {
    name: "frame-ancestors",
    sources: ["'none'"],
    because:
      "nothing here is meant to be embedded; this is the half of `X-Frame-Options: DENY` " +
      "that browsers still honour",
  },
  {
    name: "form-action",
    sources: ["'self'"],
    because:
      "Server Actions and the NextAuth endpoints are all same-origin, so an off-site form " +
      "target is either a mistake or an exfiltration",
  },
];

/** Sources that must never appear in `script-src`. */
export const FORBIDDEN_SCRIPT_SOURCES: readonly {
  source: string;
  because: string;
}[] = [
  {
    source: "'unsafe-inline'",
    because:
      "the spec item forbids it, and a policy carrying a nonce or a hash makes a CSP3 browser " +
      "ignore it regardless — it would be a word that reads like a fallback and does nothing",
  },
  {
    source: "'unsafe-eval'",
    because:
      "nothing in the production bundle evaluates code from a string; only Turbopack's dev " +
      "runtime does, which is why the development policy is a separate branch rather than " +
      "this one relaxed",
  },
  {
    source: "'strict-dynamic'",
    because:
      "it makes a browser ignore every host source, `'self'` included, so the 13–18 " +
      'parser-inserted `<script src="/_next/static/…">` tags in every prerendered document ' +
      "— which carry no nonce, because the document was rendered before the request existed " +
      "— are all refused. Rule 2 below is what measures that; this names it",
  },
];

/** The path a request would use to be answered with this document. */
export function requestPathFor(document: PrerenderedDocument): string {
  return servedPath(document.route).replaceAll(
    /\[{1,2}(?:\.{3})?[^\]]+\]{1,2}/g,
    DYNAMIC_SEGMENT_PROBE,
  );
}

/** The policy the proxy would build for a request that ends at this document. */
export function policyFor(
  manifest: ShellHashManifest,
  document: PrerenderedDocument,
  nonce: string,
): Map<string, string[]> {
  const shell = resolveShell(manifest, requestPathFor(document));

  return parsePolicy(
    buildPolicy({
      // Withheld for a regenerating document, exactly as `decideCsp` withholds
      // it: that is what keeps a nonce out of a shared cache entry.
      nonce: shell.regenerates ? undefined : nonce,
      shellHashes: shell.hashes,
      documentRegenerates: shell.regenerates,
      mode: "production",
      secure: true,
      // This build's own configuration: nothing third-party is mounted unless a
      // deployment sets the analytics domain, and this build did not. Rule 6
      // covers the configured case from the catalogue instead of guessing here.
      thirdParty: {},
    }),
  );
}

/** Every `<script src>` in a document, in document order. */
export function externalScripts(html: string): string[] {
  const sources: string[] = [];

  for (const match of html.matchAll(/<script[^>]*\bsrc="([^"]*)"[^>]*>/g)) {
    const src = match[1];
    if (src !== undefined && src !== "") sources.push(src);
  }

  return sources;
}

/**
 * Rule 1 and rule 2: the browser's own question, asked per document.
 *
 * The nonce is deliberately *not* offered to either check. A prerendered
 * document's script tags carry no nonce attribute — that is the measured fact
 * this whole feature is built around — so a check that passed the nonce in would
 * be asserting against a document Next does not write.
 */
export function checkDocuments(
  documents: readonly PrerenderedDocument[],
  manifest: ShellHashManifest,
): Violation[] {
  const violations: Violation[] = [];
  const nonce = "GateNonceNotInAnyDocument==";

  let blockedInline = 0;
  let blockedExternal = 0;
  const inlineOffenders: string[] = [];
  const externalOffenders: string[] = [];

  for (const document of documents) {
    const policy = policyFor(manifest, document, nonce);

    for (const body of inlineScripts(document.html)) {
      if (allowsInlineScript(policy, digest(body))) continue;
      blockedInline++;
      if (inlineOffenders.length < 5) {
        inlineOffenders.push(
          `${document.route}: ${JSON.stringify(body.slice(0, 60))}…`,
        );
      }
    }

    for (const src of externalScripts(document.html)) {
      if (allowsExternalScript(policy, src)) continue;
      blockedExternal++;
      if (externalOffenders.length < 5) {
        externalOffenders.push(`${document.route}: ${src}`);
      }
    }
  }

  if (blockedInline > 0) {
    violations.push({
      problem:
        `the policy refuses ${blockedInline} inline script(s) in the prerendered documents, ` +
        `e.g.\n      ${inlineOffenders.join("\n      ")}`,
      because:
        `every inline script in a prerendered document needs a \`'sha256-…'\` source — it can never ` +
        `carry a nonce — so a missing digest is a page that paints and never hydrates. Re-run ` +
        `\`pnpm csp:hashes\` after the build; if that does not fix it, the document contains an ` +
        `inline script written outside Next's own output`,
    });
  }

  if (blockedExternal > 0) {
    violations.push({
      problem:
        `the policy refuses ${blockedExternal} external script tag(s) in the prerendered ` +
        `documents, e.g.\n      ${externalOffenders.join("\n      ")}`,
      because:
        "a prerendered document loads its chunk graph through parser-inserted `<script src>` tags " +
        "with no nonce on them, so `script-src` has to keep `'self'` and must not carry " +
        "`'strict-dynamic'`, which makes a browser ignore it",
    });
  }

  return violations;
}

/** Rule 3: the manifest belongs to the build being checked. */
export function checkManifestFreshness(
  manifest: ShellHashManifest,
  buildId: string,
): Violation[] {
  if (manifest.buildId === buildId) return [];

  return [
    {
      problem:
        `${MANIFEST_FILE} was emitted for build \`${manifest.buildId}\`, and this build is ` +
        `\`${buildId}\`.`,
      because:
        "the digests describe the bytes of one specific build's documents, so a manifest from " +
        "another build authorises scripts that are no longer served and refuses the ones that are",
    },
  ];
}

/** Rule 4: no source that would make the strict policy decorative. */
export function checkForbiddenSources(
  policy: Map<string, string[]>,
): Violation[] {
  const sources = policy.get("script-src") ?? [];

  return FORBIDDEN_SCRIPT_SOURCES.filter(({ source }) =>
    sources.includes(source),
  ).map(({ source, because }) => ({
    problem: `\`script-src\` contains \`${source}\`.`,
    because,
  }));
}

/**
 * Rule 4b: the relaxed policy is coherent, and is the only one that is relaxed.
 *
 * A document Next re-renders at runtime gets `'self' 'unsafe-inline'` — see
 * `PolicyInput.documentRegenerates`. Two things have to hold for that to be worth
 * anything, and both are silent when they do not:
 *
 *  - **No nonce and no digest beside it.** A CSP3 browser ignores
 *    `'unsafe-inline'` as soon as either is present, so the relaxed policy would
 *    refuse every inline script in a document that has no nonce on it — the
 *    outage the relaxation exists to avoid, reached by a policy that reads
 *    permissive.
 *  - **`'unsafe-inline'` really is there.** Otherwise the regenerated document's
 *    inline scripts match no digest in a manifest written one build ago, and the
 *    page paints and never hydrates.
 */
export function checkRelaxedPolicy(
  manifest: ShellHashManifest,
  nonce: string,
): Violation[] {
  const violations: Violation[] = [];

  const regenerating = [
    ...Object.entries(manifest.exact)
      .filter(([, entry]) => entry.regenerates)
      .map(([route]) => route),
    ...manifest.dynamic
      .filter((shell) => shell.regenerates)
      .map((shell) =>
        shell.route.replaceAll(
          /\[{1,2}(?:\.{3})?[^\]]+\]{1,2}/g,
          DYNAMIC_SEGMENT_PROBE,
        ),
      ),
  ];

  for (const route of regenerating) {
    const shell = resolveShell(manifest, route);
    const sources =
      parsePolicy(
        buildPolicy({
          nonce: shell.regenerates ? undefined : nonce,
          shellHashes: shell.hashes,
          documentRegenerates: shell.regenerates,
          mode: "production",
          secure: true,
          thirdParty: {},
        }),
      ).get("script-src") ?? [];

    if (!sources.includes("'unsafe-inline'")) {
      violations.push({
        problem:
          `\`${route}\` is re-rendered at runtime and its \`script-src\` is ` +
          `\`${sources.join(" ")}\`, with no \`'unsafe-inline'\`.`,
        because:
          "a revalidation writes a document whose inline scripts match no digest this build " +
          "emitted, so any policy that requires a nonce or a digest refuses all of them",
      });
      continue;
    }

    const inert = sources.filter(
      (source) => source.startsWith("'nonce-") || source.startsWith("'sha256-"),
    );

    if (inert.length > 0) {
      violations.push({
        problem:
          `\`${route}\` has \`'unsafe-inline'\` *and* ${inert.length} nonce/digest source(s) in ` +
          "`script-src`.",
        because:
          "a CSP3 browser ignores `'unsafe-inline'` as soon as a nonce or a hash is present, so " +
          "this policy reads permissive and refuses every inline script in a document that has " +
          "no nonce on it",
      });
    }
  }

  return violations;
}

/**
 * Rule 4c: the relaxation covers exactly the routes the build says it must.
 *
 * `regenerates` is derived from `initialRevalidateSeconds` in the prerender
 * manifest, and this holds the emitted manifest against that same source. Both
 * directions are failures with no other symptom: a revalidating route left strict
 * is a page that stops hydrating the first time it is revalidated — minutes after
 * a deploy, on a route nobody re-tests — and a fixed route marked as
 * regenerating is `'unsafe-inline'` handed to a document that never needed it.
 */
export function checkRegenerationDerivation(
  manifest: ShellHashManifest,
  prerenderManifest: unknown,
): Violation[] {
  const violations: Violation[] = [];
  const revalidating = revalidatingRoutes(prerenderManifest);

  const marked = new Set<string>([
    ...Object.entries(manifest.exact)
      .filter(([, entry]) => entry.regenerates)
      .map(([route]) => route),
    ...manifest.dynamic
      .filter((shell) => shell.regenerates)
      .map((shell) => shell.route),
  ]);

  for (const route of revalidating) {
    if (marked.has(route)) continue;
    violations.push({
      problem:
        `\`${route}\` has a revalidation window in the prerender manifest and is not marked ` +
        "as re-rendered at runtime in " +
        `${MANIFEST_FILE}.`,
      because:
        "its document is replaced at runtime by a render this build never saw, so the digests " +
        "stop matching and a nonce gets baked into the cache entry every later visitor is served",
    });
  }

  for (const route of marked) {
    // A prerendered instance of a revalidating dynamic route inherits the
    // window from its pattern, so it is marked without an entry of its own.
    const pattern = manifest.dynamic.find(
      (shell) => shell.regenerates && new RegExp(shell.regex).test(route),
    );
    if (revalidating.has(route) || pattern !== undefined) continue;

    violations.push({
      problem:
        `\`${route}\` is marked as re-rendered at runtime, and the prerender manifest gives it ` +
        "no revalidation window.",
      because:
        "that marking is what hands a path `'unsafe-inline'`, and a document fixed at build time " +
        "is fully covered by its digests",
    });
  }

  return violations;
}

/** Rule 5: the directives whose absence nothing else would notice. */
export function checkRequiredDirectives(
  policy: Map<string, string[]>,
): Violation[] {
  const violations: Violation[] = [];

  for (const { name, sources, because } of REQUIRED_DIRECTIVES) {
    const actual = policy.get(name);

    if (actual === undefined) {
      violations.push({ problem: `no \`${name}\` directive.`, because });
      continue;
    }

    for (const source of sources) {
      if (!actual.includes(source)) {
        violations.push({
          problem: `\`${name}\` is \`${actual.join(" ")}\`, which does not include \`${source}\`.`,
          because,
        });
      }
    }
  }

  return violations;
}

/**
 * Rule 6: the policy and the third-party catalogue say the same thing.
 *
 * Both directions matter. A catalogue host the policy omits is a vendor the
 * browser is asked to contact and refuses — a feature that works in review and
 * is blocked in production. An origin in the policy that the catalogue has never
 * heard of is the opposite failure: a permission granted to a host that no
 * inventory records, which is precisely what `docs/third-party-scripts.md`
 * exists to prevent.
 */
export function checkCatalogueAgreement(nonce: string): Violation[] {
  const violations: Violation[] = [];

  // Every third party configured, so the policy contains its full surface.
  const policy = parsePolicy(
    buildPolicy({
      nonce,
      mode: "production",
      secure: true,
      thirdParty: { plausibleDomain: "example.com" },
    }),
  );

  const directiveFor: Record<string, string> = {
    script: "script-src",
    facade: "frame-src",
    asset: "img-src",
  };

  const expected = new Set<string>();

  for (const entry of THIRD_PARTIES) {
    const directive = directiveFor[entry.loading.mode];
    if (directive === undefined) continue;

    for (const host of entry.hosts) {
      const origin = `https://${host.replace(/^\*\*\./, "*.")}`;
      expected.add(origin);

      if (!(policy.get(directive) ?? []).includes(origin)) {
        violations.push({
          problem: `\`${directive}\` does not allow \`${origin}\`.`,
          because:
            `\`${entry.id}\` is in the third-party catalogue as \`${entry.loading.mode}\`, so a ` +
            "browser is asked to contact it and the policy has to say so — " +
            "`src/lib/third-party/catalogue.ts` is the one record both read",
        });
      }
    }
  }

  for (const [name, sources] of policy) {
    for (const source of sources) {
      if (!source.startsWith("https://")) continue;
      if (expected.has(source)) continue;
      violations.push({
        problem: `\`${name}\` allows \`${source}\`, which is in no catalogue entry.`,
        because:
          "an origin the browser may contact that the third-party inventory does not record is " +
          "exactly what that inventory exists to make impossible",
      });
    }
  }

  return violations;
}

/**
 * Rule 7: the proxy still applies it.
 *
 * The cheapest thing to lose and the most expensive: deleting the two calls from
 * `src/proxy.ts` leaves every unit test in this repository passing, every
 * document still prerendered, and no policy on any response. A grep is a coarse
 * check and the right one here — what it is asserting is that a specific
 * function is still called in a specific file, which is a textual property.
 */
export function checkProxyWiring(source: string): Violation[] {
  const required: readonly { needle: string; because: string }[] = [
    {
      needle: "decideCsp(",
      because:
        "the policy for a request is built here; without this call nothing mints a nonce",
    },
    {
      needle: "applyCspRequestHeaders(",
      because:
        "Next reads the nonce from the *request's* policy header, so a policy set only on the " +
        "response means no rendered script is ever nonced — the dynamic half of every PPR route " +
        "silently stops being authorised",
    },
    {
      needle: "applyCspHeaders(",
      because:
        "this is what puts the policy on the response; without it a browser is told nothing and " +
        "enforces nothing",
    },
  ];

  return required
    .filter(({ needle }) => !source.includes(needle))
    .map(({ needle, because }) => ({
      problem: `src/proxy.ts no longer calls \`${needle.replace("(", "")}\`.`,
      because,
    }));
}

/** Whether a module opens with a directive. */
function hasDirective(text: string, directive: string): boolean {
  return new RegExp(
    `^\\s*(?:/\\*[\\s\\S]*?\\*/\\s*|//[^\\n]*\\n\\s*)*["']${directive}["']`,
  ).test(text);
}

/**
 * The modules that actually execute in a browser.
 *
 * Every `"use client"` entry point and everything reachable from one — but the
 * walk **stops at a `"use server"` module**, and that is the whole reason this
 * is here rather than reusing `collectClientGraph` from the React Compiler gate.
 * A client component importing a Server Action does not ship that action's code
 * to the browser; Next replaces the import with a reference, and the module runs
 * on the server only. Following it anyway pulls in `src/auth.ts`, four action
 * modules and their validation layer, all of which construct Zod schemas and none
 * of which a browser ever evaluates — 10 findings, every one of them false. The
 * React Compiler gate can afford that over-approximation because Next hands it
 * the same over-wide set; a rule about what a browser does cannot.
 */
export function browserModules(
  files: readonly SourceFile[],
): readonly SourceFile[] {
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  const known = new Set(byPath.keys());

  const reached = new Set<string>();
  const queue = files
    .filter((file) => hasDirective(file.text, "use client"))
    .map((file) => file.relativePath);

  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (reached.has(current)) continue;

    const file = byPath.get(current);
    if (!file) continue;
    // A server boundary: reachable by name, never evaluated in a browser.
    if (hasDirective(file.text, "use server")) continue;

    reached.add(current);

    for (const match of file.text.matchAll(
      /(?:from\s*|import\s*)["']([^"']+)["']/g,
    )) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const resolved = resolveSpecifier(current, specifier, known);
      if (resolved !== null && !reached.has(resolved)) queue.push(resolved);
    }
  }

  return files
    .filter((file) => reached.has(file.relativePath))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * Rule 8: no module that runs in a browser probes for `eval`.
 *
 * Zod v4 decides whether to JIT-compile an object validator by calling
 * `new Function("")` inside a `try`, when the schema is *constructed*. Under this
 * policy that throws, Zod falls back, the page works — and the browser reports a
 * `script-src` violation for the caught `eval` on every page load, which is a
 * reporting endpoint full of noise and a console that says the policy is broken
 * when it is not. `disableZodJitInBrowser()` turns the probe off in the browser
 * and leaves the fast path on the server; see `@/lib/security/zod-jitless`.
 *
 * Checked positionally, because the memoised probe runs at construction: a call
 * *below* the first `z.object(` in the file is a call that happens too late.
 */
export function checkZodJitProbe(
  clientGraph: readonly { relativePath: string; text: string }[],
): Violation[] {
  const violations: Violation[] = [];

  for (const file of clientGraph) {
    if (!/\bfrom "zod"/.test(file.text)) continue;
    if (file.relativePath === ZOD_JITLESS_MODULE) continue;

    // Comments stripped first, and not as a nicety: the prose explaining why the
    // call is there says `z.object()` in it, which a positional check reading the
    // raw text finds *above* the call and reports as a call that comes too late.
    const code = withoutComments(file.text);
    const guard = code.indexOf(`${ZOD_JITLESS_CALL}(`);
    // Whitespace-tolerant: this repository writes `z\n  .object({…})` as often as
    // `z.object({…})`, and a pattern that only matched the second missed
    // `src/lib/vitals/metric.ts` — the module whose schema actually fired the
    // probe on every page load.
    const firstSchema = code.search(
      /\bz\s*\.\s*(object|strictObject|looseObject)\s*\(/,
    );

    if (firstSchema === -1) continue;

    if (guard === -1) {
      violations.push({
        problem:
          `${file.relativePath} is in the client graph, builds a Zod object schema, and never ` +
          `calls \`${ZOD_JITLESS_CALL}()\`.`,
        because:
          'constructing a `z.object()` in a browser probes for `eval` with `new Function("")`, ' +
          "which this policy refuses — the throw is caught and the page still works, but every " +
          "page view reports a `script-src` violation that looks exactly like a real one",
      });
      continue;
    }

    if (guard > firstSchema) {
      violations.push({
        problem: `${file.relativePath} calls \`${ZOD_JITLESS_CALL}()\` after its first schema.`,
        because:
          "Zod reads the `eval` capability when a schema is constructed and memoises the answer, " +
          "so a call below the schema configures nothing and the probe has already fired",
      });
    }
  }

  return violations;
}

/**
 * Source with its comments blanked out, positions preserved.
 *
 * Replaced by spaces rather than removed so that every offset in the result still
 * refers to the same character of the original file, which is what makes the
 * positional check below meaningful. Deliberately not a parser: it tracks strings
 * and template literals so a `//` inside one is not mistaken for a comment, and
 * that is the whole of what this needs.
 */
export function withoutComments(text: string): string {
  let out = "";
  let index = 0;
  let quote: string | null = null;

  while (index < text.length) {
    const char = text[index] as string;
    const next = text[index + 1];

    if (quote !== null) {
      if (char === "\\") {
        out += "  ";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      out += char;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; index < stop; index += 1) out += text[index] === "\n" ? "\n" : " ";
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/** The module that owns the browser-only Zod configuration, and its export. */
export const ZOD_JITLESS_MODULE = "src/lib/security/zod-jitless.ts";
export const ZOD_JITLESS_CALL = "disableZodJitInBrowser";

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map((v) => `  ${v.problem}\n    expected because: ${v.because}`)
    .join("\n\n");
}

export interface CheckInput {
  readonly documents: readonly PrerenderedDocument[];
  readonly manifest: ShellHashManifest | undefined;
  readonly buildId: string;
  readonly proxySource: string;
  readonly clientGraph: readonly SourceFile[];
  /** `.next/prerender-manifest.json`, the source `regenerates` is derived from. */
  readonly prerenderManifest: unknown;
}

export function checkCsp(input: CheckInput): Violation[] {
  const nonce = "GateNonceNotInAnyDocument==";

  if (input.manifest === undefined) {
    return [
      {
        problem: `no readable ${MANIFEST_FILE} in the build directory.`,
        because:
          "the prerendered documents' inline scripts are authorised by digest and by nothing " +
          "else, so without this file every one of them is refused. `pnpm csp:hashes` writes it " +
          "from the build output and has to run after every build",
      },
    ];
  }

  // The strict policy: what every path gets unless its document is re-rendered
  // at runtime.
  const policy = parsePolicy(
    buildPolicy({
      nonce,
      mode: "production",
      secure: true,
      thirdParty: {},
    }),
  );

  return [
    ...checkManifestFreshness(input.manifest, input.buildId),
    ...checkForbiddenSources(policy),
    ...checkRelaxedPolicy(input.manifest, nonce),
    ...checkRegenerationDerivation(input.manifest, input.prerenderManifest),
    ...checkRequiredDirectives(policy),
    ...checkCatalogueAgreement(nonce),
    ...checkProxyWiring(input.proxySource),
    ...checkZodJitProbe(input.clientGraph),
    ...checkDocuments(input.documents, input.manifest),
  ];
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readManifest(nextDir: string): ShellHashManifest | undefined {
  try {
    return parseManifest(
      JSON.parse(readFileSync(path.join(nextDir, MANIFEST_FILE), "utf8")),
    );
  } catch {
    return undefined;
  }
}

function main(argv: readonly string[]): number {
  const nextDir = argv[0] ?? ".next";
  const documents = readPrerenderedDocuments(nextDir);

  if (documents.length === 0) {
    console.error(
      `No prerendered documents under ${path.join(nextDir, "server", "app")}.\n` +
        "Run `next build` first — this gate checks the policy against the HTML the build wrote.\n",
    );
    return 1;
  }

  const manifest = readManifest(nextDir);

  const violations = checkCsp({
    documents,
    manifest,
    buildId: readBuildId(nextDir),
    proxySource: readFileSync("src/proxy.ts", "utf8"),
    clientGraph: browserModules(collectSources(process.cwd())),
    prerenderManifest: readJson(path.join(nextDir, "prerender-manifest.json")),
  });

  if (violations.length > 0) {
    console.error(
      `Content Security Policy — ${violations.length} problem(s):\n\n` +
        `${formatViolations(violations)}\n\n` +
        "A policy that refuses this application's own scripts is not caught by any other check\n" +
        "here: the build exits 0, the documents are served, and the pages never hydrate.\n" +
        "See docs/csp.md.\n",
    );
    return 1;
  }

  // Unreachable: `checkCsp` returns a violation for a missing manifest, and the
  // block above exits on one. Here so the summary below can read it.
  /* c8 ignore next */
  if (manifest === undefined) return 1;

  const byDigest = documents.filter(
    (document) => !resolveShell(manifest, requestPathFor(document)).regenerates,
  );
  const relaxed = documents.length - byDigest.length;
  const inline = byDigest.reduce(
    (sum, document) => sum + inlineScripts(document.html).length,
    0,
  );
  const external = documents.reduce(
    (sum, document) => sum + externalScripts(document.html).length,
    0,
  );

  console.log(
    `CSP OK — ${documents.length} prerendered document(s): ${inline} inline script(s) ` +
      `authorised by digest, ${external} external tag(s) by \`'self'\`, ` +
      `${relaxed} document(s) re-rendered at runtime and served ` +
      "`script-src 'self' 'unsafe-inline'`, " +
      `${REQUIRED_DIRECTIVES.length} required directive(s) present, ` +
      `${FORBIDDEN_SCRIPT_SOURCES.length} forbidden source(s) absent, ` +
      "catalogue and policy in agreement.",
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
