import { describe, expect, it } from "vitest";
import {
  DOCUMENTS_WITHOUT_ROOT_LAYOUT,
  FONT_ROLES,
  FORBIDDEN_FONT_ORIGINS,
  OVERRIDE_PROPERTIES,
  allFontFaces,
  checkFallbackOrder,
  checkFaceSources,
  checkFontFilesExist,
  checkFontLoading,
  checkOverrideMetrics,
  checkPreloadReferenced,
  checkPreloadedSubset,
  checkSelfHosted,
  checkVariableClassOnHtml,
  computeOverrides,
  customPropertyMap,
  formatViolations,
  isAdjustedFallback,
  isPreloadable,
  metricsKey,
  parseCustomProperties,
  parseFontFaces,
  parseSources,
  readCapsizeMetrics,
  resolveFamilyList,
  splitTopLevel,
  unquote,
  type Document,
  type FontBuild,
  type FontMetrics,
  type MediaFile,
  type Stylesheet,
} from "./assert-font-loading";

/**
 * The metrics the real table holds for the four families this repository
 * touches, copied at the precision the table stores them.
 *
 * Inlined rather than read from `node_modules` so the arithmetic tests state
 * their own inputs: a test that both reads the table and checks a number
 * derived from it proves only that two calls agree. `capsizeMetricsMatch`
 * below is the one test that pins these to the real file, so a Next upgrade
 * that re-measures a font fails there, once, rather than everywhere.
 */
const METRICS = new Map<string, FontMetrics>([
  [
    "inter",
    {
      ascent: 1984,
      descent: -494,
      lineGap: 0,
      unitsPerEm: 2048,
      xWidthAvg: 978,
    },
  ],
  [
    "jetBrainsMono",
    {
      ascent: 1020,
      descent: -300,
      lineGap: 0,
      unitsPerEm: 1000,
      xWidthAvg: 600,
    },
  ],
  [
    "arial",
    {
      ascent: 1854,
      descent: -434,
      lineGap: 67,
      unitsPerEm: 2048,
      xWidthAvg: 913,
    },
  ],
  [
    "courierNew",
    {
      ascent: 1705,
      descent: -615,
      lineGap: 0,
      unitsPerEm: 2048,
      xWidthAvg: 1229,
    },
  ],
]);

/** The emitted name of a preloaded file, in Next's `<hash>[-s].p.<hash>.woff2` shape. */
const INTER_SUBSET = "83afe278b6a6bb3c-s.p.2bn3s6zvc0dyp.woff2";
const MONO_SUBSET = "70bc3e132a0a741e.p.3t6q91iet4nsy.woff2";
/** A subset that was emitted but not requested, so not marked for preload. */
const INTER_CYRILLIC = "2c55a0e60120577a.0-dom-5bn10r2.woff2";

/**
 * The stylesheet a healthy build writes, reduced to the parts this gate reads.
 *
 * Written the way the minifier writes it — unquoted multi-word family names,
 * `0.0%` from one code path and `0%` from another — because those are the
 * spellings the parser has to survive, and a tidied-up copy would quietly test
 * a stylesheet no build produces.
 */
function healthyCss(): string {
  return (
    "@font-face{font-family:Inter;font-style:normal;font-display:swap;" +
    `src:url(../media/${INTER_SUBSET})format("woff2");unicode-range:U+??,U+131}` +
    "@font-face{font-family:Inter;font-style:normal;font-display:swap;" +
    `src:url(../media/${INTER_CYRILLIC})format("woff2");unicode-range:U+460-52F}` +
    "@font-face{font-family:Inter Fallback;src:local(Arial);ascent-override:90.44%;" +
    "descent-override:22.52%;line-gap-override:0.0%;size-adjust:107.12%}" +
    "@font-face{font-family:JetBrains Mono;font-style:normal;font-display:swap;" +
    `src:url(../media/${MONO_SUBSET})format("woff2");unicode-range:U+??}` +
    "@font-face{font-family:JetBrains Mono Metric Fallback;" +
    "src:local(Courier New),local(Liberation Mono);ascent-override:102.02%;" +
    "descent-override:30%;line-gap-override:0%;size-adjust:99.98%}" +
    '.inter_8983b2d2-module__9oJzCW__variable{--font-inter:"Inter", "Inter Fallback"}' +
    ".jetbrains_mono_d1719fd-module__qLWADq__variable{--font-jetbrains-mono:" +
    '"JetBrains Mono", JetBrains Mono Metric Fallback, ui-monospace, monospace}' +
    ":root{--font-sans:var(--font-inter), system-ui, sans-serif;" +
    "--font-mono:var(--font-jetbrains-mono), monospace}"
  );
}

function healthyStylesheets(css = healthyCss()): Stylesheet[] {
  return [{ file: "static/chunks/app.css", css }];
}

const HTML_CLASSES =
  "inter_8983b2d2-module__9oJzCW__variable jetbrains_mono_d1719fd-module__qLWADq__variable";

function healthyDocuments(): Document[] {
  return [
    {
      file: "index.html",
      html:
        `<!DOCTYPE html><html lang="en" class="${HTML_CLASSES}"><head>` +
        `<link rel="stylesheet" href="/_next/static/chunks/app.css"/></head>` +
        `<body>:HL["/_next/static/media/${INTER_SUBSET}","font",{"crossOrigin":""}]` +
        `:HL["/_next/static/media/${MONO_SUBSET}","font",{"crossOrigin":""}]</body></html>`,
    },
    {
      file: "blog.html",
      html: `<!DOCTYPE html><html lang="en" class="${HTML_CLASSES}"><body></body></html>`,
    },
    {
      // Replaces the root layout, so it legitimately has no font variables.
      file: "_global-error.html",
      html: '<!DOCTYPE html><html id="__next_error__"><body></body></html>',
    },
  ];
}

function healthyMedia(): MediaFile[] {
  return [
    { name: INTER_SUBSET, bytes: 48_432 },
    { name: MONO_SUBSET, bytes: 40_480 },
    { name: INTER_CYRILLIC, bytes: 25_844 },
  ];
}

function healthyBuild(overrides: Partial<FontBuild> = {}): FontBuild {
  return {
    stylesheets: healthyStylesheets(),
    documents: healthyDocuments(),
    media: healthyMedia(),
    ...overrides,
  };
}

/** The whole gate over one build, for the tests that care about the verdict. */
function violationsFor(build: FontBuild): string[] {
  return checkFontLoading(build, METRICS).map((violation) => violation.problem);
}

describe("parsing", () => {
  it("splits a family list on top-level commas only", () => {
    expect(
      splitTopLevel('var(--font-inter), "Inter Fallback", system-ui'),
    ).toEqual(["var(--font-inter)", '"Inter Fallback"', "system-ui"]);
  });

  it("does not split inside a var() fallback or a quoted family", () => {
    expect(splitTopLevel('var(--a, "X, Y"), z')).toEqual([
      'var(--a, "X, Y")',
      "z",
    ]);
  });

  it("strips quotes and collapses whitespace in a family name", () => {
    expect(unquote('  "Inter  Fallback" ')).toBe("Inter Fallback");
    expect(unquote("JetBrains Mono")).toBe("JetBrains Mono");
  });

  it("reads every @font-face, its sources, display and overrides", () => {
    const faces = parseFontFaces(healthyCss());

    expect(faces.map((face) => face.family)).toEqual([
      "Inter",
      "Inter",
      "Inter Fallback",
      "JetBrains Mono",
      "JetBrains Mono Metric Fallback",
    ]);

    const inter = faces[0];
    expect(inter?.display).toBe("swap");
    expect(inter?.sources).toEqual([
      { kind: "url", value: `../media/${INTER_SUBSET}` },
    ]);

    const fallback = faces[4];
    expect(fallback?.overrides).toEqual({
      "ascent-override": 102.02,
      "descent-override": 30,
      "line-gap-override": 0,
      "size-adjust": 99.98,
    });
  });

  it("reads src entries in order, keeping url and local apart", () => {
    expect(
      parseSources('local("Courier New"), local(Liberation Mono)'),
    ).toEqual([
      { kind: "local", value: "Courier New" },
      { kind: "local", value: "Liberation Mono" },
    ]);
  });

  it("treats a face as adjusted only when all four overrides are present", () => {
    const [, , interFallback, jetBrains] = parseFontFaces(healthyCss());

    expect(isAdjustedFallback(interFallback!)).toBe(true);
    expect(isAdjustedFallback(jetBrains!)).toBe(false);
  });

  it("attributes each custom property to the selector that declares it", () => {
    const properties = parseCustomProperties(healthyCss());
    const inter = properties.find(
      (property) => property.name === "--font-inter",
    );

    expect(inter?.selector).toBe(".inter_8983b2d2-module__9oJzCW__variable");
    expect(
      properties.find((property) => property.name === "--font-sans")?.selector,
    ).toBe(":root");
  });

  it("flattens a family list through its var() references", () => {
    const properties = customPropertyMap(healthyStylesheets());

    expect(resolveFamilyList("var(--font-sans)", properties)).toEqual([
      "Inter",
      "Inter Fallback",
      "system-ui",
      "sans-serif",
    ]);
  });

  it("falls back inside var() when the property is undefined, as a browser does", () => {
    const properties = new Map([["--defined", '"Real"']]);

    expect(resolveFamilyList("var(--defined, serif)", properties)).toEqual([
      "Real",
    ]);
    expect(resolveFamilyList("var(--missing, serif)", properties)).toEqual([
      "serif",
    ]);
    expect(resolveFamilyList("var(--missing)", properties)).toEqual([]);
  });

  it("stops rather than hangs on a self-referential variable", () => {
    const properties = new Map([["--loop", "var(--loop)"]]);

    expect(resolveFamilyList("var(--loop)", properties)).toEqual([]);
  });
});

describe("the override arithmetic", () => {
  it("reproduces the numbers Next generates for Inter on Arial", () => {
    const overrides = computeOverrides(
      METRICS.get("inter")!,
      METRICS.get("arial")!,
    );

    expect(overrides["size-adjust"].toFixed(2)).toBe("107.12");
    expect(overrides["ascent-override"].toFixed(2)).toBe("90.44");
    expect(overrides["descent-override"].toFixed(2)).toBe("22.52");
    expect(overrides["line-gap-override"].toFixed(2)).toBe("0.00");
  });

  it("reproduces the numbers written into globals.css for JetBrains Mono on Courier New", () => {
    const overrides = computeOverrides(
      METRICS.get("jetBrainsMono")!,
      METRICS.get("courierNew")!,
    );

    expect(overrides["size-adjust"].toFixed(2)).toBe("99.98");
    expect(overrides["ascent-override"].toFixed(2)).toBe("102.02");
    expect(overrides["descent-override"].toFixed(2)).toBe("30.00");
    expect(overrides["line-gap-override"].toFixed(2)).toBe("0.00");
  });

  /**
   * The reason the monospace face does not use the donor Next would have
   * picked. Arial has to be stretched by a third to match JetBrains Mono's
   * average advance; Courier New is already the same 0.6 em.
   */
  it("shows why Arial is the wrong donor for a monospace face", () => {
    const onArial = computeOverrides(
      METRICS.get("jetBrainsMono")!,
      METRICS.get("arial")!,
    );

    expect(onArial["size-adjust"].toFixed(2)).toBe("134.59");
  });

  it("camel-cases a family the way Next keys its metric table", () => {
    expect(metricsKey("Inter")).toBe("inter");
    expect(metricsKey("JetBrains Mono")).toBe("jetBrainsMono");
    expect(metricsKey("Courier New")).toBe("courierNew");
  });

  /**
   * The one test that reads the real table. It pins the four families this
   * repository depends on to the numbers `globals.css` was computed from, so a
   * Next upgrade that re-measures a font fails here — once, with a readable
   * diff — rather than as a byte comparison somewhere in the gate.
   */
  it("matches the capsize metrics Next actually ships", () => {
    const real = readCapsizeMetrics();

    for (const [key, expected] of METRICS) {
      expect(real.get(key), key).toEqual(expected);
    }
  });
});

describe("a healthy build", () => {
  it("raises nothing", () => {
    expect(checkFontLoading(healthyBuild(), METRICS)).toEqual([]);
  });

  it("reads five faces across the emitted stylesheets", () => {
    expect(allFontFaces(healthyStylesheets())).toHaveLength(5);
  });
});

describe("self-hosting", () => {
  it.each(FORBIDDEN_FONT_ORIGINS)("rejects %s in a stylesheet", (origin) => {
    const css = `@import url(https://${origin}/css2?family=Inter);${healthyCss()}`;

    expect(checkSelfHosted(healthyStylesheets(css), [])).toHaveLength(1);
  });

  /** The shape of the embed snippet Google Fonts hands out. */
  it("rejects a stylesheet link in the document", () => {
    const documents: Document[] = [
      {
        file: "index.html",
        html: '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"/>',
      },
    ];

    expect(checkSelfHosted([], documents)).toHaveLength(1);
  });

  it("rejects a face served from an absolute URL", () => {
    const css = healthyCss().replace(
      `url(../media/${INTER_SUBSET})`,
      "url(https://cdn.example.com/inter.woff2)",
    );

    expect(
      checkFaceSources(parseFontFaces(css)).map((v) => v.problem),
    ).toContainEqual(expect.stringContaining("absolute URL"));
  });

  it("rejects a face that renders invisible text while it loads", () => {
    const css = healthyCss().replace("font-display:swap", "font-display:block");

    expect(
      checkFaceSources(parseFontFaces(css)).map((v) => v.problem),
    ).toContainEqual(expect.stringContaining("font-display: block"));
  });

  it("does not ask a local-only fallback face for a font-display", () => {
    const localOnly = parseFontFaces(
      "@font-face{font-family:Inter Fallback;src:local(Arial);size-adjust:107.12%}",
    );

    expect(checkFaceSources(localOnly)).toEqual([]);
  });

  it("rejects a face pointing at a file the build did not emit", () => {
    const build = healthyBuild({
      media: healthyMedia().filter((file) => file.name !== INTER_SUBSET),
    });

    expect(
      checkFontFilesExist(allFontFaces(build.stylesheets), build.media),
    ).toHaveLength(1);
  });
});

describe("the metric-matched fallback", () => {
  /**
   * The regression this gate was written for, reproduced exactly as the build
   * produced it: `fallback: ["system-ui", "arial", "sans-serif"]` passed to
   * `next/font`, which removes the adjusted face instead of adding to it. Every
   * font still loads; only the face laying out the first paint changes.
   */
  it("rejects the family list `fallback` produces", () => {
    const css = healthyCss()
      .replace(
        '--font-inter:"Inter", "Inter Fallback"',
        '--font-inter:"Inter", system-ui, arial, sans-serif',
      )
      .replace(
        "@font-face{font-family:Inter Fallback;src:local(Arial);ascent-override:90.44%;" +
          "descent-override:22.52%;line-gap-override:0.0%;size-adjust:107.12%}",
        "",
      );

    expect(
      violationsFor(healthyBuild({ stylesheets: healthyStylesheets(css) })),
    ).toEqual([
      expect.stringContaining(
        "whose second entry `system-ui` is a generic keyword",
      ),
    ]);
  });

  it("rejects an unadjusted family sitting in the fallback position", () => {
    const css = healthyCss().replace(
      '--font-inter:"Inter", "Inter Fallback"',
      '--font-inter:"Inter", "Helvetica Neue", "Inter Fallback"',
    );

    expect(
      checkFallbackOrder(
        customPropertyMap(healthyStylesheets(css)),
        allFontFaces(healthyStylesheets(css)),
      ).map((v) => v.problem),
    ).toEqual([
      expect.stringContaining(
        "not declared by an @font-face carrying all four layout overrides",
      ),
    ]);
  });

  it("rejects a family list with no fallback at all", () => {
    const css = healthyCss()
      .replace('--font-inter:"Inter", "Inter Fallback"', '--font-inter:"Inter"')
      .replace(
        "--font-sans:var(--font-inter), system-ui, sans-serif",
        "--font-sans:var(--font-inter)",
      );

    expect(
      checkFallbackOrder(
        customPropertyMap(healthyStylesheets(css)),
        allFontFaces(healthyStylesheets(css)),
      ).map((v) => v.problem),
    ).toEqual([expect.stringContaining("and nothing else")]);
  });

  it("rejects a role whose theme variable was never bound", () => {
    const css = healthyCss().replace(
      "--font-mono:var(--font-jetbrains-mono), monospace",
      "",
    );

    expect(
      checkFallbackOrder(
        customPropertyMap(healthyStylesheets(css)),
        allFontFaces(healthyStylesheets(css)),
      ).map((v) => v.problem),
    ).toEqual([expect.stringContaining("no `--font-mono` is defined")]);
  });

  it("rejects a family list that no longer starts with the font it names", () => {
    const css = healthyCss().replace(
      '--font-inter:"Inter", "Inter Fallback"',
      '--font-inter:"Inter Fallback", "Inter"',
    );

    expect(
      checkFallbackOrder(
        customPropertyMap(healthyStylesheets(css)),
        allFontFaces(healthyStylesheets(css)),
      ).map((v) => v.problem),
    ).toEqual([expect.stringContaining("does not start with `Inter`")]);
  });

  it.each(OVERRIDE_PROPERTIES)(
    "rejects a fallback whose %s has drifted from the metrics",
    (property) => {
      const css = healthyCss()
        .replace(`${property}:99.98%`, `${property}:88%`)
        .replace(`${property}:102.02%`, `${property}:88%`)
        .replace(`${property}:30%`, `${property}:88%`)
        .replace(`${property}:0%;size-adjust`, `${property}:88%;size-adjust`);

      const violations = checkOverrideMetrics(
        customPropertyMap(healthyStylesheets(css)),
        allFontFaces(healthyStylesheets(css)),
        METRICS,
      );

      expect(violations.map((v) => v.problem)).toEqual([
        expect.stringContaining(`${property}: 88%`),
      ]);
    },
  );

  it("rejects a fallback with overrides but no local source to apply them to", () => {
    const css = healthyCss().replace(
      "src:local(Courier New),local(Liberation Mono);",
      "",
    );

    expect(
      checkOverrideMetrics(
        customPropertyMap(healthyStylesheets(css)),
        allFontFaces(healthyStylesheets(css)),
        METRICS,
      ).map((v) => v.problem),
    ).toEqual([expect.stringContaining("no `local()` source")]);
  });

  it("reports rather than guesses when a family is missing from the metric table", () => {
    const withoutCourier = new Map(METRICS);
    withoutCourier.delete("courierNew");

    expect(
      checkOverrideMetrics(
        customPropertyMap(healthyStylesheets()),
        allFontFaces(healthyStylesheets()),
        withoutCourier,
      ).map((v) => v.problem),
    ).toEqual([expect.stringContaining("no metrics for `Courier New`")]);
  });

  /**
   * The gate must accept the donor Next picks as readily as the one this
   * repository picks for the monospace face — it checks a face against the
   * donor the face itself names, not against a preferred answer.
   */
  it("accepts the Arial donor Next generates for the sans face", () => {
    expect(
      checkOverrideMetrics(
        customPropertyMap(healthyStylesheets()),
        allFontFaces(healthyStylesheets()),
        METRICS,
      ),
    ).toEqual([]);
  });
});

describe("subsetting", () => {
  it("recognises the preload marker as a whole path segment", () => {
    expect(isPreloadable(INTER_SUBSET)).toBe(true);
    expect(isPreloadable(MONO_SUBSET)).toBe(true);
    expect(isPreloadable(INTER_CYRILLIC)).toBe(false);
    // A hash containing the letter is not the marker.
    expect(isPreloadable("apq3f.2p9zqw.woff2")).toBe(false);
  });

  it("rejects a second preloaded subset for one family", () => {
    const second = "9c72aa0f40e4eef8.p.1y4-pdgsjb-pw.woff2";
    const css = healthyCss().replace(
      `url(../media/${INTER_CYRILLIC})`,
      `url(../media/${second})`,
    );
    const media = [
      ...healthyMedia().filter((file) => file.name !== INTER_CYRILLIC),
      { name: second, bytes: 25_844 },
    ];

    // Both counts are genuinely wrong and both are reported: Inter now
    // preloads two subsets, and the build preloads three files for two roles.
    expect(
      checkPreloadedSubset(allFontFaces(healthyStylesheets(css)), media).map(
        (v) => v.problem,
      ),
    ).toEqual([
      expect.stringContaining("`Inter` preloads 2 files"),
      expect.stringContaining("3 font files are marked for preload"),
    ]);
  });

  it("rejects a preloaded subset that has outgrown its budget", () => {
    const media = healthyMedia().map((file) =>
      file.name === INTER_SUBSET ? { ...file, bytes: 140_000 } : file,
    );

    expect(
      checkPreloadedSubset(allFontFaces(healthyStylesheets()), media).map(
        (v) => v.problem,
      ),
    ).toEqual([expect.stringContaining("over its 60000-byte budget")]);
  });

  it("rejects a family that preloads nothing", () => {
    const css = healthyCss().replace(
      `url(../media/${MONO_SUBSET})`,
      `url(../media/${INTER_CYRILLIC})`,
    );

    expect(
      checkPreloadedSubset(
        allFontFaces(healthyStylesheets(css)),
        healthyMedia(),
      ).map((v) => v.problem),
    ).toEqual([
      expect.stringContaining("no preloaded font file for `JetBrains Mono`"),
    ]);
  });

  it("rejects a preloadable file belonging to no declared role", () => {
    const stray = "0000000000000000.p.aaaaaaaaaaaaa.woff2";
    const media = [...healthyMedia(), { name: stray, bytes: 30_000 }];

    expect(
      checkPreloadedSubset(allFontFaces(healthyStylesheets()), media).map(
        (v) => v.problem,
      ),
    ).toEqual([expect.stringContaining("3 font files are marked for preload")]);
  });

  it("rejects a preloaded file nothing in the output references", () => {
    const documents = healthyDocuments().map((document) => ({
      ...document,
      html: document.html.replaceAll(MONO_SUBSET, "other.woff2"),
    }));

    expect(
      checkPreloadReferenced(documents, healthyMedia()).map((v) => v.problem),
    ).toEqual([expect.stringContaining(MONO_SUBSET)]);
  });
});

describe("the wiring onto <html>", () => {
  /**
   * The failure that looks most like success: every font still built, still
   * preloaded, still declared — and nothing resolving them, because the class
   * moved one element down the tree.
   */
  it("rejects the variable class moved from <html> to <body>", () => {
    const documents = healthyDocuments().map((document) =>
      document.file === "index.html"
        ? {
            ...document,
            html: document.html
              .replace(
                `<html lang="en" class="${HTML_CLASSES}">`,
                '<html lang="en">',
              )
              .replace("<body>", `<body class="${HTML_CLASSES}">`),
          }
        : document,
    );

    expect(
      checkVariableClassOnHtml(
        parseCustomProperties(healthyCss()),
        documents,
      ).map((v) => v.problem),
    ).toEqual([
      expect.stringContaining(
        "index.html has no class defining `--font-inter`",
      ),
      expect.stringContaining(
        "index.html has no class defining `--font-jetbrains-mono`",
      ),
    ]);
  });

  it.each(DOCUMENTS_WITHOUT_ROOT_LAYOUT)(
    "exempts %s, which replaces the root layout",
    (file) => {
      const documents = healthyDocuments().filter(
        (document) => document.file === file,
      );

      expect(
        checkVariableClassOnHtml(
          parseCustomProperties(healthyCss()),
          documents,
        ),
      ).toEqual([]);
    },
  );

  it("rejects a font variable that no class rule declares", () => {
    const css = healthyCss().replace(
      '.inter_8983b2d2-module__9oJzCW__variable{--font-inter:"Inter", "Inter Fallback"}',
      ':root{--font-inter:"Inter", "Inter Fallback"}',
    );

    expect(
      checkVariableClassOnHtml(
        parseCustomProperties(css),
        healthyDocuments(),
      ).map((v) => v.problem),
    ).toEqual([
      expect.stringContaining(
        "`--font-inter` is not declared by any class rule",
      ),
    ]);
  });
});

describe("reporting", () => {
  it("says so plainly when the build wrote no stylesheet", () => {
    expect(
      checkFontLoading(healthyBuild({ stylesheets: [] }), METRICS).map(
        (v) => v.problem,
      ),
    ).toEqual(["the build wrote no stylesheet at all."]);
  });

  it("prints each violation with the reason it is one", () => {
    const formatted = formatViolations([
      { problem: "something broke.", because: "it matters" },
    ]);

    expect(formatted).toContain("something broke.");
    expect(formatted).toContain("expected because: it matters");
  });

  it("declares a role for every typeface the stylesheet binds", () => {
    expect(FONT_ROLES.map((role) => role.variable)).toEqual([
      "--font-sans",
      "--font-mono",
    ]);
  });
});
