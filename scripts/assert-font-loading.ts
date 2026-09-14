/**
 * Asserts that the fonts are self-hosted, subset, and laid out on a
 * metric-matched fallback — from the build output rather than the source.
 *
 * Every property this gate checks is invisible everywhere else. A page with
 * badly-loaded fonts renders the same words in the same places to whoever
 * opens it after the font has been cached, which is everyone who works on it.
 * The build succeeds, the tests pass, the screenshots match. The cost lands on
 * a first-time visitor on a slow connection, as a paragraph that jumps once
 * the real font arrives, and it lands in a metric — Cumulative Layout Shift —
 * that this repository already collects and nobody reads per-commit.
 *
 * Three failures in particular are what it exists for, and the first two were
 * found by building this application rather than by reasoning about it:
 *
 * 1. **`fallback` silently replaces the metric-matched face.** Declared as
 *    `Inter({ fallback: ["system-ui", "arial", "sans-serif"] })` with
 *    `adjustFontFallback` left at its default of `true`, this build emitted no
 *    adjusted `@font-face` at all and resolved the family to
 *    `"Inter", system-ui, arial, sans-serif`. The option reads as *extra*
 *    fallbacks and acts as a switch that turns the anti-CLS machinery off.
 *    Nothing warns; the build is a second faster and the pages shift.
 *
 * 2. **`adjustFontFallback: false` does nothing here.** With no `fallback` and
 *    that flag explicitly false, the adjusted faces were emitted anyway: the
 *    flag is implemented in
 *    `next/dist/build/webpack/loaders/next-font-loader/postcss-next-font.js`,
 *    and Next 16 builds with Turbopack, which does not run it. So neither the
 *    presence of the option nor its value tells you what the build did. Only
 *    the emitted CSS does, which is what this reads.
 *
 * 3. **The order of the family list is the whole of the behaviour.** A generic
 *    keyword moved ahead of the adjusted face puts an unadjusted system font in
 *    front of a matched one and restores the shift, changing nothing else that
 *    anyone would notice in review.
 *
 * It also re-derives the four override percentages from
 * `next/dist/server/capsize-font-metrics.json` — the table Next itself reads —
 * so the hand-written face in `globals.css` stays a computed value rather than
 * four magic numbers, and a font swapped out from under it fails here instead
 * of quietly laying out against the old one's metrics.
 *
 * **What it deliberately does not assert.** No prerendered document in this
 * build carries a `<link rel="preload" as="font">` in its head. The preload is
 * emitted as a React resource hint inside the RSC payload
 * (`:HL["…woff2","font",{"crossOrigin":""}]`), which the client acts on after
 * the payload streams and parses, and it is present in 15 of the 26 documents
 * rather than all of them. The font is still discovered early — the
 * `@font-face` lives in the render-blocking stylesheet the head does link — but
 * roughly a round trip later than a head preload would manage. Asserting a
 * head link would fail a healthy build, so this checks the weaker property that
 * is actually true: the subset is marked preloadable and something in the
 * output references it. See docs/fonts.md.
 *
 * Usage: tsx scripts/assert-font-loading.ts [path-to-.next]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export interface Violation {
  problem: string;
  because: string;
}

/** A stylesheet the build emitted, paired with its contents. */
export interface Stylesheet {
  /** Path as it should be printed on failure, relative to the build dir. */
  file: string;
  css: string;
}

/** A prerendered document, paired with its markup. */
export interface Document {
  /** Path relative to `.next/server/app`, e.g. `blog/[slug].html`. */
  file: string;
  html: string;
}

/** A font file the build wrote to `.next/static/media`. */
export interface MediaFile {
  name: string;
  bytes: number;
}

/** Everything this gate reads, in the shape the checks consume. */
export interface FontBuild {
  stylesheets: readonly Stylesheet[];
  documents: readonly Document[];
  media: readonly MediaFile[];
}

export interface FontSource {
  kind: "url" | "local";
  value: string;
}

/**
 * The four descriptors that make a fallback lay out like the font it stands in
 * for. A face carrying all four is an adjusted fallback; a face carrying none
 * is an ordinary one.
 */
export const OVERRIDE_PROPERTIES = [
  "size-adjust",
  "ascent-override",
  "descent-override",
  "line-gap-override",
] as const;

export type OverrideProperty = (typeof OVERRIDE_PROPERTIES)[number];

export interface FontFace {
  /** Family name with quotes stripped, as written. */
  family: string;
  sources: FontSource[];
  display: string | undefined;
  unicodeRange: string | undefined;
  /** Percentages, parsed. Absent keys were not declared. */
  overrides: Partial<Record<OverrideProperty, number>>;
}

/**
 * The subset of `capsize-font-metrics.json` the override formula needs.
 *
 * Typed rather than imported as JSON: the file is ~4 MB of font tables, and
 * `resolveJsonModule` would hand every one of them to the type checker on
 * every run to learn six numbers.
 */
export interface FontMetrics {
  ascent: number;
  descent: number;
  lineGap: number;
  unitsPerEm: number;
  xWidthAvg: number;
}

/** One typographic role, and what the build must have done to serve it. */
export interface FontRole {
  /** The Tailwind theme variable, e.g. `--font-sans`. */
  variable: string;
  /** The family `next/font` was asked for. */
  family: string;
  /**
   * Ceiling for the preloaded subset, in bytes.
   *
   * Sized to catch a *change in what was asked for* rather than ordinary
   * churn: a font file is a build input, so it does not drift the way a
   * JavaScript chunk does. Adding the `opsz` axis to Inter, a second weight, or
   * an italic face all grow this number; nothing else does.
   */
  maxPreloadBytes: number;
  because: string;
}

export const FONT_ROLES: readonly FontRole[] = [
  {
    variable: "--font-sans",
    family: "Inter",
    // Measured at 48,432 bytes for the latin subset of the variable face.
    maxPreloadBytes: 60_000,
    because:
      "Inter is the body face — every page of this application is set in it, so its " +
      "loading behaviour is the loading behaviour of the site",
  },
  {
    variable: "--font-mono",
    family: "JetBrains Mono",
    // Measured at 40,480 bytes for the latin subset of the variable face.
    maxPreloadBytes: 60_000,
    because:
      "`font-mono` is used inline inside flowing paragraphs on /blog and /photos, where a " +
      "fallback that measures differently moves the wrap point of the text around it",
  },
];

/**
 * Hosts that must never appear in the output.
 *
 * Their presence means someone has gone back to a stylesheet `<link>` —
 * usually by pasting the embed snippet Google Fonts hands out — and every
 * property below it is moot: the CSS is a render-blocking request to a host
 * the browser has not connected to, the font file is a second one behind it,
 * and neither can be described by a CSP that does not name a third party.
 */
export const FORBIDDEN_FONT_ORIGINS: readonly string[] = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

/**
 * CSS generic family keywords.
 *
 * These end a family list: the browser will always find something for them, so
 * nothing after one is ever consulted, and anything *before* the adjusted
 * fallback face displaces it.
 */
export const GENERIC_FAMILIES: readonly string[] = [
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
];

/**
 * Documents that legitimately carry no font variables.
 *
 * `/_global-error` replaces the root layout rather than nesting inside it, so
 * its `<html>` is rendered by Next and never receives the class that defines
 * `--font-inter` and `--font-jetbrains-mono`. Every other document in the
 * build descends from `app/layout.tsx` and must have them.
 */
export const DOCUMENTS_WITHOUT_ROOT_LAYOUT: readonly string[] = [
  "_global-error.html",
];

/** Percentage points of slack when comparing a written override to a computed one. */
const OVERRIDE_TOLERANCE = 0.011;

/* ------------------------------------------------------------------ parsing */

/**
 * Splits a comma-separated list on its top-level commas.
 *
 * Paren- and quote-aware, because both appear inside the values this parses:
 * `src: local("Courier New"), local("Liberation Mono")` and
 * `font-family: var(--font-inter), system-ui` are one declaration each.
 */
export function splitTopLevel(value: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";

  for (const char of value) {
    if (quote !== null) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === separator && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());

  return parts.filter((part) => part !== "");
}

/** Strips one layer of matching quotes, and collapses internal whitespace. */
export function unquote(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  const first = trimmed[0];
  if (
    (first === '"' || first === "'") &&
    trimmed.length > 1 &&
    trimmed.endsWith(first)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Family names compare case-insensitively, and the minifier drops the quotes. */
function sameFamily(a: string, b: string): boolean {
  return unquote(a).toLowerCase() === unquote(b).toLowerCase();
}

function isGeneric(family: string): boolean {
  return GENERIC_FAMILIES.includes(unquote(family).toLowerCase());
}

/**
 * Reads every `@font-face` rule in a stylesheet.
 *
 * `@font-face` bodies contain no nested blocks, so the block boundary is the
 * next `}` and a full CSS parser buys nothing here.
 */
export function parseFontFaces(css: string): FontFace[] {
  const faces: FontFace[] = [];

  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = match[1];
    if (body === undefined) continue;

    const face: FontFace = {
      family: "",
      sources: [],
      display: undefined,
      unicodeRange: undefined,
      overrides: {},
    };

    for (const declaration of splitTopLevel(body, ";")) {
      const colon = declaration.indexOf(":");
      if (colon === -1) continue;
      const name = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();

      if (name === "font-family") face.family = unquote(value);
      else if (name === "font-display") face.display = value.toLowerCase();
      else if (name === "unicode-range") face.unicodeRange = value;
      else if (name === "src") face.sources = parseSources(value);
      else if ((OVERRIDE_PROPERTIES as readonly string[]).includes(name)) {
        const percentage = Number.parseFloat(value);
        if (!Number.isNaN(percentage)) {
          face.overrides[name as OverrideProperty] = percentage;
        }
      }
    }

    faces.push(face);
  }

  return faces;
}

/** Reads the `url(…)` and `local(…)` entries of an `src` declaration, in order. */
export function parseSources(value: string): FontSource[] {
  const sources: FontSource[] = [];

  for (const entry of splitTopLevel(value)) {
    const match = /^(url|local)\(\s*([^)]*?)\s*\)/i.exec(entry);
    if (!match) continue;
    const kind = match[1]?.toLowerCase() === "url" ? "url" : "local";
    const inner = match[2];
    if (inner === undefined) continue;
    sources.push({ kind, value: unquote(inner) });
  }

  return sources;
}

/** A custom property declaration, with the selector that carries it. */
export interface CustomProperty {
  name: string;
  value: string;
  /** Selector of the rule it was declared in, e.g. `:root` or `.inter_abc__variable`. */
  selector: string;
}

/**
 * Reads every custom property in a stylesheet, in emission order.
 *
 * Tracks brace depth and remembers the prelude that opened each block, which
 * is all that is needed to attribute a declaration to its selector. Quoted
 * strings are skipped so a `content: "}"` cannot unbalance it.
 */
export function parseCustomProperties(css: string): CustomProperty[] {
  const properties: CustomProperty[] = [];
  const selectors: string[] = [];
  let prelude = "";
  let quote: string | null = null;
  let depth = 0;

  const flush = (declaration: string): void => {
    const trimmed = declaration.trim();
    if (!trimmed.startsWith("--")) return;
    const colon = trimmed.indexOf(":");
    if (colon === -1) return;
    properties.push({
      name: trimmed.slice(0, colon).trim(),
      value: trimmed.slice(colon + 1).trim(),
      selector: selectors[selectors.length - 1] ?? "",
    });
  };

  for (const char of css) {
    if (quote !== null) {
      prelude += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      prelude += char;
      continue;
    }

    if (char === "{") {
      selectors.push(prelude.trim());
      prelude = "";
      depth++;
      continue;
    }
    if (char === "}") {
      flush(prelude);
      selectors.pop();
      prelude = "";
      depth--;
      continue;
    }
    if (char === ";") {
      if (depth > 0) flush(prelude);
      prelude = "";
      continue;
    }
    prelude += char;
  }

  return properties;
}

/**
 * Resolves a family list, expanding `var()` references against the stylesheet's
 * own custom properties.
 *
 * `--font-sans` is `var(--font-inter), system-ui, sans-serif`, and
 * `--font-inter` is `"Inter", "Inter Fallback"`. The order a browser actually
 * walks is the flattened one, and the order is the thing being asserted, so
 * the flattening has to happen before anything is checked.
 *
 * A `var()` with a fallback resolves to the property when it is defined and to
 * the fallback when it is not, the way the browser does it. An undefined
 * property with no fallback expands to nothing — also the way the browser does
 * it, and a case worth reaching the checks rather than throwing here.
 */
export function resolveFamilyList(
  value: string,
  properties: ReadonlyMap<string, string>,
  depth = 0,
): string[] {
  if (depth > 10) return [];

  return splitTopLevel(value).flatMap((entry) => {
    const match = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/.exec(entry);
    if (!match) return [unquote(entry)];

    const name = match[1];
    const fallback = match[2];
    const resolved = name === undefined ? undefined : properties.get(name);

    if (resolved !== undefined) {
      return resolveFamilyList(resolved, properties, depth + 1);
    }
    if (fallback !== undefined) {
      return resolveFamilyList(fallback, properties, depth + 1);
    }
    return [];
  });
}

/** Collapses the custom properties of every stylesheet into one lookup. */
export function customPropertyMap(
  stylesheets: readonly Stylesheet[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const sheet of stylesheets) {
    for (const { name, value } of parseCustomProperties(sheet.css)) {
      map.set(name, value);
    }
  }
  return map;
}

/** Every `@font-face` across every stylesheet. */
export function allFontFaces(stylesheets: readonly Stylesheet[]): FontFace[] {
  return stylesheets.flatMap((sheet) => parseFontFaces(sheet.css));
}

/** Whether a face carries the full set of layout overrides. */
export function isAdjustedFallback(face: FontFace): boolean {
  return OVERRIDE_PROPERTIES.every(
    (property) => face.overrides[property] !== undefined,
  );
}

/* ----------------------------------------------------------------- the maths */

/**
 * Next's key format for the capsize table: camel-cased, whitespace removed.
 *
 * Reimplemented rather than imported because the only exported entry point,
 * `calculateSizeAdjustValues`, picks the donor itself — Times New Roman for a
 * serif and Arial for everything else. This gate has to check a face against
 * the donor it actually names, which for the monospace face is Courier New.
 */
export function metricsKey(family: string): string {
  return family
    .replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index: number) =>
      index === 0 ? word.toLowerCase() : word.toUpperCase(),
    )
    .replace(/\s+/g, "");
}

/**
 * The four override percentages for a font laid out on a donor, exactly as
 * `next/dist/server/font-utils.js` computes them.
 *
 * `size-adjust` is the ratio of average character advances, expressed in em, so
 * that a line of the donor occupies the width a line of the real font will.
 * The three vertical overrides are then the real font's own metrics divided by
 * that scale factor, which pins the line box back to the real font's height
 * after the scaling has moved it.
 */
export function computeOverrides(
  font: FontMetrics,
  donor: FontMetrics,
): Record<OverrideProperty, number> {
  const fontAdvance = font.xWidthAvg / font.unitsPerEm;
  const donorAdvance = donor.xWidthAvg / donor.unitsPerEm;
  const sizeAdjust = font.xWidthAvg ? fontAdvance / donorAdvance : 1;
  const scale = font.unitsPerEm * sizeAdjust;

  return {
    "size-adjust": Math.abs(sizeAdjust * 100),
    "ascent-override": Math.abs((font.ascent / scale) * 100),
    "descent-override": Math.abs((font.descent / scale) * 100),
    "line-gap-override": Math.abs((font.lineGap / scale) * 100),
  };
}

/* ---------------------------------------------------------------- the checks */

/**
 * Fails if anything in the output still points at Google's font hosts.
 *
 * Both the stylesheets and the documents are searched: the stylesheet catches
 * an `@import`, and the document catches the `<link rel="stylesheet">` that the
 * Google Fonts embed snippet actually hands out.
 */
export function checkSelfHosted(
  stylesheets: readonly Stylesheet[],
  documents: readonly Document[],
): Violation[] {
  const violations: Violation[] = [];

  for (const origin of FORBIDDEN_FONT_ORIGINS) {
    for (const sheet of stylesheets) {
      if (sheet.css.includes(origin)) {
        violations.push({
          problem: `${sheet.file} references \`${origin}\`.`,
          because:
            "`next/font` downloads the files at build time and serves them from this origin; a " +
            "reference to Google's hosts means something bypassed it and reintroduced a " +
            "third-party request on the critical path",
        });
      }
    }
    for (const document of documents) {
      if (document.html.includes(origin)) {
        violations.push({
          problem: `${document.file} references \`${origin}\`.`,
          because:
            "a `<link>` to Google Fonts in the document is a render-blocking request to a host " +
            "the browser has not yet connected to, with the font file a second round trip behind it",
        });
      }
    }
  }

  return violations;
}

/**
 * Fails if a face fetches its file from anywhere but this origin, or renders
 * invisible text while it waits.
 *
 * `font-display` is only asked of faces that fetch a file. A fallback face is
 * a `local()` source that either resolves instantly or not at all, so it has no
 * block period to govern.
 */
export function checkFaceSources(faces: readonly FontFace[]): Violation[] {
  const violations: Violation[] = [];

  for (const face of faces) {
    const urls = face.sources.filter((source) => source.kind === "url");
    if (urls.length === 0) continue;

    for (const source of urls) {
      if (
        /^[a-z][a-z0-9+.-]*:/i.test(source.value) ||
        source.value.startsWith("//")
      ) {
        violations.push({
          problem: `\`${face.family}\` loads \`${source.value}\`, which is an absolute URL.`,
          because:
            "a self-hosted font is fetched from a path on this origin; an absolute URL is either a " +
            "third party or an environment-specific host baked into a stylesheet that is cached forever",
        });
      }
    }

    if (face.display !== "swap") {
      violations.push({
        problem: `\`${face.family}\` declares \`font-display: ${face.display ?? "<unset>"}\`, not \`swap\`.`,
        because:
          "the default is `auto`, which most browsers treat as `block`: up to three seconds of " +
          "invisible text on a slow connection, in exchange for avoiding a shift the metric " +
          "overrides have already made imperceptible",
      });
    }
  }

  return violations;
}

/** Locates the adjusted fallback a role's family list actually resolves to. */
function stackFor(
  role: FontRole,
  properties: ReadonlyMap<string, string>,
): string[] | undefined {
  const declared = properties.get(role.variable);
  if (declared === undefined) return undefined;
  return resolveFamilyList(declared, properties);
}

/**
 * Fails if a role's family list is not `<real font>, <adjusted fallback>, …`.
 *
 * This is the check that would have caught the `fallback` option quietly
 * removing the adjusted face: the family list stayed plausible
 * (`"Inter", system-ui, arial, sans-serif`), every font still loaded, and the
 * only difference was that the face laying out the first frame was no longer
 * matched to the one replacing it.
 *
 * The second position is asserted exactly rather than "somewhere before the
 * generics", because there is no reason for anything to sit between a font and
 * the face that stands in for it, and "somewhere" is how an unadjusted family
 * ends up first in a list that still technically satisfies the gate.
 */
export function checkFallbackOrder(
  properties: ReadonlyMap<string, string>,
  faces: readonly FontFace[],
  roles: readonly FontRole[] = FONT_ROLES,
): Violation[] {
  const violations: Violation[] = [];

  for (const role of roles) {
    const stack = stackFor(role, properties);

    if (stack === undefined) {
      violations.push({
        problem: `no \`${role.variable}\` is defined in any emitted stylesheet.`,
        because: `${role.because}, and the \`@theme\` block in globals.css is what binds it to a typeface`,
      });
      continue;
    }

    const first = stack[0];
    if (first === undefined || !sameFamily(first, role.family)) {
      violations.push({
        problem:
          `\`${role.variable}\` resolves to \`${stack.join(", ")}\`, which does not start with ` +
          `\`${role.family}\`.`,
        because: `${role.because}, so the face the application is set in has to be the first one asked for`,
      });
      continue;
    }

    const second = stack[1];
    if (second === undefined) {
      violations.push({
        problem: `\`${role.variable}\` resolves to \`${role.family}\` and nothing else.`,
        because:
          "a single-entry family list has no fallback at all, so the first paint uses the browser's " +
          "default font and every line re-flows when the real one arrives",
      });
      continue;
    }

    const fallbackFace = faces.find(
      (face) => sameFamily(face.family, second) && isAdjustedFallback(face),
    );

    if (fallbackFace === undefined) {
      violations.push({
        problem:
          `\`${role.variable}\` resolves to \`${stack.join(", ")}\`, whose second entry ` +
          `\`${second}\` is ${isGeneric(second) ? "a generic keyword" : "not declared by an @font-face carrying all four layout overrides"}.`,
        because:
          `${role.because}. The face that lays out the first paint must carry \`size-adjust\`, ` +
          "`ascent-override`, `descent-override` and `line-gap-override`, or the swap to the real " +
          "font changes the size of every line box and moves everything below it. Passing " +
          "`fallback` to `next/font` removes this face — see the note at the top of this file",
      });
    }
  }

  return violations;
}

/**
 * Fails if a written override no longer matches the metrics it was derived
 * from.
 *
 * The numbers in `globals.css` are computed values that happen to be written
 * down. Swapping the typeface, or the donor, without recomputing them leaves a
 * fallback confidently laid out to the wrong font's proportions — which is
 * worse than no fallback at all, because it is wrong by a specific amount in
 * every line rather than obviously unstyled.
 */
export function checkOverrideMetrics(
  properties: ReadonlyMap<string, string>,
  faces: readonly FontFace[],
  metrics: ReadonlyMap<string, FontMetrics>,
  roles: readonly FontRole[] = FONT_ROLES,
): Violation[] {
  const violations: Violation[] = [];

  for (const role of roles) {
    const stack = stackFor(role, properties);
    const second = stack?.[1];
    if (second === undefined) continue; // Already reported by checkFallbackOrder.

    const face = faces.find(
      (candidate) =>
        sameFamily(candidate.family, second) && isAdjustedFallback(candidate),
    );
    if (face === undefined) continue; // Likewise.

    const donorName = face.sources.find(
      (source) => source.kind === "local",
    )?.value;
    if (donorName === undefined) {
      violations.push({
        problem: `\`${face.family}\` declares layout overrides but no \`local()\` source.`,
        because:
          "an adjusted fallback is a system font wearing another font's metrics; with no local " +
          "source there is nothing for the overrides to apply to and the family is skipped entirely",
      });
      continue;
    }

    const font = metrics.get(metricsKey(role.family));
    const donor = metrics.get(metricsKey(donorName));

    if (font === undefined || donor === undefined) {
      violations.push({
        problem:
          `no metrics for \`${font === undefined ? role.family : donorName}\` in ` +
          "`next/dist/server/capsize-font-metrics.json`.",
        because:
          "the override percentages are derived from that table, so a family missing from it " +
          "cannot be checked — and if Next cannot measure it either, it cannot generate a " +
          "matched fallback for it",
      });
      continue;
    }

    const expected = computeOverrides(font, donor);

    for (const property of OVERRIDE_PROPERTIES) {
      const written = face.overrides[property];
      const computed = expected[property];
      if (written === undefined) continue; // isAdjustedFallback guarantees otherwise.

      if (Math.abs(written - computed) > OVERRIDE_TOLERANCE) {
        violations.push({
          problem:
            `\`${face.family}\` declares \`${property}: ${written}%\`, but ${role.family} on ` +
            `${donorName} computes to ${computed.toFixed(2)}%.`,
          because:
            `${role.because}. The overrides are derived from capsize-font-metrics.json and a ` +
            "value that has drifted from them lays the fallback out to a font nobody is loading",
        });
      }
    }
  }

  return violations;
}

/**
 * Fails if more than the requested subset was preloaded, or if the preloaded
 * file grew.
 *
 * `subsets: ["latin"]` does not decide which font files exist — all seven of
 * Inter's subsets are emitted and reachable through their `unicode-range`, so a
 * page that renders Greek still gets Greek. It decides which are *preloaded*,
 * and a preloaded file is paid for on the critical path of every page whether
 * its glyphs are used or not. Adding a subset here is the difference between
 * 48 kB and several times that before the first paint.
 */
export function checkPreloadedSubset(
  faces: readonly FontFace[],
  media: readonly MediaFile[],
  roles: readonly FontRole[] = FONT_ROLES,
): Violation[] {
  const violations: Violation[] = [];
  const preloadable = media.filter((file) => isPreloadable(file.name));

  for (const role of roles) {
    const files = faces
      .filter((face) => sameFamily(face.family, role.family))
      .flatMap((face) => face.sources)
      .filter((source) => source.kind === "url")
      .map((source) => path.basename(source.value))
      .filter((name) => isPreloadable(name));

    const unique = [...new Set(files)];

    if (unique.length === 0) {
      violations.push({
        problem: `no preloaded font file for \`${role.family}\`.`,
        because:
          `${role.because}. Either \`preload\` was turned off or \`subsets\` was dropped, and the ` +
          "browser now discovers the font only once it has fetched and parsed the stylesheet",
      });
      continue;
    }

    if (unique.length > 1) {
      violations.push({
        problem: `\`${role.family}\` preloads ${unique.length} files (${unique.join(", ")}).`,
        because:
          "one preloaded file per family is one subset; more than one means `subsets` grew, and " +
          "every added subset is downloaded before the first paint by every visitor, including " +
          "the ones whose pages contain none of its glyphs",
      });
    }

    for (const name of unique) {
      const file = preloadable.find((candidate) => candidate.name === name);
      if (file === undefined) {
        violations.push({
          problem: `\`${role.family}\` preloads \`${name}\`, which is not in the build output.`,
          because:
            "a preload for a file that does not exist is a 404 on the critical path of every page",
        });
        continue;
      }
      if (file.bytes > role.maxPreloadBytes) {
        violations.push({
          problem:
            `\`${role.family}\` preloads ${file.bytes} bytes (${name}), over its ` +
            `${role.maxPreloadBytes}-byte budget.`,
          because:
            `${role.because}. A font file is a build input rather than a compiled artefact, so this ` +
            "number does not drift — it moves when an axis, a weight or a style is added to the request",
        });
      }
    }
  }

  if (preloadable.length > roles.length) {
    violations.push({
      problem:
        `${preloadable.length} font files are marked for preload, for ${roles.length} declared ` +
        `role(s): ${preloadable.map((file) => file.name).join(", ")}.`,
      because:
        "every preloadable file is fetched before the first paint; one that belongs to no role in " +
        "FONT_ROLES is being paid for by every visitor and measured by nothing",
    });
  }

  return violations;
}

/**
 * Whether Next marked this emitted file for preloading.
 *
 * The marker is a `p` path segment in the emitted name
 * (`83afe278b6a6bb3c-s.p.2bn3s6zvc0dyp.woff2`), written by `emitFontFile` for
 * the subsets that were requested. Matched as a whole dot-delimited segment so
 * that a hash happening to contain the letter cannot be mistaken for it.
 */
export function isPreloadable(fileName: string): boolean {
  return fileName.split(".").includes("p");
}

/**
 * Fails if nothing in the output references a preloaded file.
 *
 * Deliberately weak, and weak for a reason given at the top of this file: the
 * hint lives in the RSC payload rather than in a head `<link>`, and reaches
 * only the documents whose payload carries it. Requiring it per-document would
 * fail a healthy build. What it does catch is the file being marked for preload
 * and then referenced by nothing at all, which is what `preload: false` plus a
 * stale build output looks like.
 */
export function checkPreloadReferenced(
  documents: readonly Document[],
  media: readonly MediaFile[],
): Violation[] {
  const preloadable = media.filter((file) => isPreloadable(file.name));

  return preloadable
    .filter(
      (file) =>
        !documents.some((document) => document.html.includes(file.name)),
    )
    .map((file) => ({
      problem: `\`${file.name}\` is marked for preload but is referenced by no prerendered document.`,
      because:
        "the preload hint is what starts the font fetch before the stylesheet has been parsed; a " +
        "file marked preloadable and hinted nowhere is carrying the cost of the marker and none of " +
        "the benefit",
    }));
}

/**
 * Fails if a document's `<html>` has lost the class that defines the font
 * variables.
 *
 * This is the wiring check, and it is the one whose failure looks most like
 * success. `className={fontVariables}` moved from `<html>` to `<body>`, or
 * dropped in a refactor of the root layout, leaves every font file still built,
 * still preloaded and still declared — and `--font-sans` resolving to an
 * undefined variable, so the whole application renders in `system-ui` with a
 * correct-looking stylesheet behind it.
 *
 * The class name is read out of the stylesheet rather than hardcoded: it is a
 * content hash (`inter_8983b2d2-module__9oJzCW__variable`) that changes with
 * the font file.
 */
export function checkVariableClassOnHtml(
  properties: readonly CustomProperty[],
  documents: readonly Document[],
  roles: readonly FontRole[] = FONT_ROLES,
): Violation[] {
  const violations: Violation[] = [];
  const propertyMap = new Map(
    properties.map((property) => [property.name, property.value]),
  );

  // The variables the roles are built on — `--font-inter` behind `--font-sans`
  // — are the ones `next/font` puts on `<html>`.
  const sourceNames = new Set<string>();
  for (const role of roles) {
    const declared = propertyMap.get(role.variable);
    if (declared === undefined) continue;
    for (const match of declared.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const name = match[1];
      if (name !== undefined) sourceNames.add(name);
    }
  }

  for (const name of sourceNames) {
    const classNames = properties
      .filter(
        (property) =>
          property.name === name && property.selector.startsWith("."),
      )
      .map((property) => property.selector.slice(1));

    if (classNames.length === 0) {
      violations.push({
        problem: `\`${name}\` is not declared by any class rule.`,
        because:
          "`next/font` publishes a family through a generated class; a variable defined anywhere " +
          "else is not the one the font module produced",
      });
      continue;
    }

    for (const document of documents) {
      if (DOCUMENTS_WITHOUT_ROOT_LAYOUT.includes(document.file)) continue;

      const htmlTag = /<html[^>]*>/i.exec(document.html)?.[0] ?? "";
      const classAttribute = /class="([^"]*)"/i.exec(htmlTag)?.[1] ?? "";
      const applied = classAttribute.split(/\s+/);

      if (!classNames.some((className) => applied.includes(className))) {
        violations.push({
          problem:
            `${document.file} has no class defining \`${name}\` on its \`<html>\` element ` +
            `(found: ${classAttribute === "" ? "<none>" : classAttribute}).`,
          because:
            "the `@theme` block reads these variables at `:root`, so the class has to be on " +
            "`<html>`. One element lower and every `font-sans` utility in the application silently " +
            "resolves to the generic fallback",
        });
      }
    }
  }

  return violations;
}

/** Fails if a face points at a file the build did not write. */
export function checkFontFilesExist(
  faces: readonly FontFace[],
  media: readonly MediaFile[],
): Violation[] {
  const names = new Set(media.map((file) => file.name));

  return faces
    .flatMap((face) =>
      face.sources
        .filter((source) => source.kind === "url")
        .map((source) => ({ face, name: path.basename(source.value) })),
    )
    .filter(({ name }) => !names.has(name))
    .map(({ face, name }) => ({
      problem: `\`${face.family}\` loads \`${name}\`, which is not in \`static/media\`.`,
      because:
        "a font file referenced but not emitted is a 404 and a face the browser silently discards, " +
        "leaving the text in the fallback permanently",
    }));
}

/** Runs every check against one build. */
export function checkFontLoading(
  build: FontBuild,
  metrics: ReadonlyMap<string, FontMetrics>,
  roles: readonly FontRole[] = FONT_ROLES,
): Violation[] {
  if (build.stylesheets.length === 0) {
    return [
      {
        problem: "the build wrote no stylesheet at all.",
        because:
          "`next/font` emits its `@font-face` rules into the application stylesheet, so a build " +
          "with no CSS has no fonts either",
      },
    ];
  }

  const faces = allFontFaces(build.stylesheets);
  const properties = build.stylesheets.flatMap((sheet) =>
    parseCustomProperties(sheet.css),
  );
  const propertyMap = customPropertyMap(build.stylesheets);

  return [
    ...checkSelfHosted(build.stylesheets, build.documents),
    ...checkFaceSources(faces),
    ...checkFallbackOrder(propertyMap, faces, roles),
    ...checkOverrideMetrics(propertyMap, faces, metrics, roles),
    ...checkPreloadedSubset(faces, build.media, roles),
    ...checkPreloadReferenced(build.documents, build.media),
    ...checkVariableClassOnHtml(properties, build.documents, roles),
    ...checkFontFilesExist(faces, build.media),
  ];
}

/* ------------------------------------------------------------------ the I/O */

/**
 * Reads the capsize metric table Next itself measures fonts against.
 *
 * Loaded through `createRequire` rather than imported, so that the 4 MB of
 * font tables never reaches the type checker — and so that a Next version
 * which moves or drops the file fails with a sentence rather than a module
 * resolution error.
 */
export function readCapsizeMetrics(): Map<string, FontMetrics> {
  const require = createRequire(import.meta.url);
  let table: Record<string, Partial<FontMetrics>>;

  try {
    table = require("next/dist/server/capsize-font-metrics.json") as Record<
      string,
      Partial<FontMetrics>
    >;
  } catch {
    throw new Error(
      "Could not read `next/dist/server/capsize-font-metrics.json`. It is the table " +
        "`next/font` derives its fallback overrides from, and this gate re-derives them from " +
        "the same numbers; a Next upgrade that moves it needs this path updated.",
    );
  }

  const metrics = new Map<string, FontMetrics>();
  for (const [key, entry] of Object.entries(table)) {
    const { ascent, descent, lineGap, unitsPerEm, xWidthAvg } = entry;
    if (
      typeof ascent === "number" &&
      typeof descent === "number" &&
      typeof lineGap === "number" &&
      typeof unitsPerEm === "number" &&
      typeof xWidthAvg === "number"
    ) {
      metrics.set(key, { ascent, descent, lineGap, unitsPerEm, xWidthAvg });
    }
  }

  return metrics;
}

function walk(dir: string, matches: (name: string) => boolean): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Turbopack's intermediate artefacts, which include copies of source CSS
      // that would satisfy these checks without anything being served.
      if (entry.name === "cache") continue;
      found.push(...walk(full, matches));
    } else if (matches(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Reads the stylesheets, prerendered documents and font files of a build. */
export function readFontBuild(nextDir: string): FontBuild {
  const staticDir = path.join(nextDir, "static");
  const appDir = path.join(nextDir, "server", "app");
  const mediaDir = path.join(staticDir, "media");

  const stylesheets = walk(staticDir, (name) => name.endsWith(".css")).map(
    (file) => ({
      file: path.relative(nextDir, file),
      css: readFileSync(file, "utf8"),
    }),
  );

  const documents = walk(appDir, (name) => name.endsWith(".html")).map(
    (file) => ({
      file: path.relative(appDir, file),
      html: readFileSync(file, "utf8"),
    }),
  );

  if (documents.length === 0) {
    throw new Error(
      `No prerendered documents under ${appDir}. Run \`pnpm build\` before this gate — ` +
        "it reads the build output, not the source.",
    );
  }

  const media = walk(mediaDir, (name) => name.endsWith(".woff2")).map(
    (file) => ({
      name: path.basename(file),
      bytes: statSync(file).size,
    }),
  );

  return { stylesheets, documents, media };
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map((v) => `  ${v.problem}\n    expected because: ${v.because}`)
    .join("\n\n");
}

function main(argv: readonly string[]): number {
  const nextDir = argv[0] ?? ".next";
  const build = readFontBuild(nextDir);
  const metrics = readCapsizeMetrics();
  const violations = checkFontLoading(build, metrics);

  if (violations.length > 0) {
    console.error(
      `Font loading is not what it should be — ${violations.length} problem(s):\n\n` +
        `${formatViolations(violations)}\n\n` +
        "`src/styles/fonts.ts` declares the faces and `src/styles/globals.css` binds them to\n" +
        "`--font-sans` and `--font-mono`. Note that passing `fallback` to `next/font` removes\n" +
        "the metric-matched fallback face rather than adding to it, and that\n" +
        "`adjustFontFallback` is a webpack-only option this build does not read.\n" +
        "See docs/fonts.md.\n",
    );
    return 1;
  }

  const faces = allFontFaces(build.stylesheets);
  const preloaded = build.media.filter((file) => isPreloadable(file.name));
  const preloadedBytes = preloaded.reduce((sum, file) => sum + file.bytes, 0);

  console.log(
    `Font loading OK — ${FONT_ROLES.length} role(s) on metric-matched fallbacks, ` +
      `${faces.length} @font-face rule(s) served from this origin, ` +
      `${preloaded.length} subset(s) preloaded totalling ${preloadedBytes} bytes, ` +
      `variables present on <html> in ${build.documents.length - DOCUMENTS_WITHOUT_ROOT_LAYOUT.length} document(s).`,
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
