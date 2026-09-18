import { describe, it, expect } from "vitest";
import ts from "typescript";
import {
  VARIANT_LISTS,
  checkCacheHeaders,
  configHeaderRules,
  checkGateCoverage,
  checkHeaderSanitising,
  checkNoRequestReads,
  checkProxyWiring,
  checkRegistry,
  checkRouteFiles,
  checkVariantLists,
  checkVariantPage,
  createFileReader,
  exportedStringArray,
  exportsName,
  main,
  metadataRobotsIndex,
  requiredFiles,
  type FileReader,
} from "./assert-experiment-wiring";
import {
  EXPERIMENTS,
  type Experiment,
} from "../src/lib/experiments/definitions";

const ROUTED: Experiment = {
  id: "demo",
  salt: "s1",
  variants: [
    { id: "control", weightBasisPoints: 5_000, because: "a" },
    { id: "treatment", weightBasisPoints: 5_000, because: "b" },
  ],
  fallbackVariantId: "control",
  route: {
    path: "/demo",
    canonicalVariantId: "control",
    rewritePrefix: "/demo/v",
  },
  because: "a fixture",
};

/** A reader over an in-memory tree. */
function reader(files: Record<string, string>): FileReader {
  return (relativePath) => files[relativePath] ?? null;
}

/** Every file `requiredFiles` asks for, with trivial contents. */
function completeTree(experiment: Experiment): Record<string, string> {
  return Object.fromEntries(
    requiredFiles(experiment).map((file) => [file, "export {};"]),
  );
}

describe("the repository as it stands", () => {
  it("passes every rule", () => {
    // The gate is only worth having if it is green on the tree it ships with;
    // a gate that has to be argued with is a gate that gets deleted.
    expect(main(process.cwd())).toBe(0);
  });

  it("covers every routed experiment with a variant list entry", () => {
    for (const experiment of EXPERIMENTS) {
      if (!experiment.route) continue;
      expect(
        VARIANT_LISTS.some(
          (location) => location.experimentId === experiment.id,
        ),
      ).toBe(true);
    }
  });
});

describe("createFileReader", () => {
  const read = createFileReader(process.cwd());

  it("reads a file that exists", () => {
    expect(read("package.json")).toContain("boilerplate-nextjs");
  });

  it("returns null for one that does not", () => {
    expect(read("does/not/exist.ts")).toBeNull();
  });
});

describe("R1 — the registry", () => {
  it("passes on the live registry", () => {
    expect(checkRegistry()).toEqual([]);
  });

  it("reports a registry whose weights do not sum", () => {
    const findings = checkRegistry([
      {
        ...ROUTED,
        variants: [
          { id: "control", weightBasisPoints: 1, because: "a" },
          { id: "treatment", weightBasisPoints: 1, because: "b" },
        ],
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R1");
    expect(findings[0]?.message).toContain("sum to 2");
  });
});

describe("R2 — the route files", () => {
  it("passes when every file is present", () => {
    expect(checkRouteFiles(reader(completeTree(ROUTED)), [ROUTED])).toEqual([]);
  });

  it("asks for every segment file both arms need", () => {
    expect(requiredFiles(ROUTED)).toEqual([
      "src/app/demo/page.tsx",
      "src/app/demo/layout.tsx",
      "src/app/demo/loading.tsx",
      "src/app/demo/error.tsx",
      "src/app/demo/v/[variant]/page.tsx",
      "src/app/demo/v/[variant]/loading.tsx",
      "src/app/demo/v/[variant]/error.tsx",
      "src/app/demo/v/[variant]/not-found.tsx",
    ]);
  });

  it("asks for nothing from an experiment with no route", () => {
    const { route: _route, ...unrouted } = ROUTED;
    expect(requiredFiles(unrouted)).toEqual([]);
  });

  it("reports a missing variant page", () => {
    const files = completeTree(ROUTED);
    delete files["src/app/demo/v/[variant]/page.tsx"];

    const findings = checkRouteFiles(reader(files), [ROUTED]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("src/app/demo/v/[variant]/page.tsx");
  });

  it("reports a missing loading segment", () => {
    const files = completeTree(ROUTED);
    delete files["src/app/demo/loading.tsx"];
    expect(checkRouteFiles(reader(files), [ROUTED])).toHaveLength(1);
  });
});

describe("R3 — the proxy wiring", () => {
  const wired = `
    import { applyExperiments, resolveExperimentContext } from "@/lib/experiments/edge";
    export default async function proxy(request) {
      const context = resolveExperimentContext(request);
      return applyExperiments(request, context, next());
    }
  `;

  it("passes on a wired proxy", () => {
    expect(checkProxyWiring(reader({ "src/proxy.ts": wired }))).toEqual([]);
  });

  it("passes on the real proxy", () => {
    expect(checkProxyWiring(createFileReader(process.cwd()))).toEqual([]);
  });

  it("reports a proxy that imports but never calls", () => {
    // The failure that produces a perfectly working application: every visitor
    // is served the canonical arm, and nothing anywhere reports it.
    const findings = checkProxyWiring(
      reader({
        "src/proxy.ts": `
          import { applyExperiments, resolveExperimentContext } from "@/lib/experiments/edge";
          export default async function proxy() { return next(); }
        `,
      }),
    );
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.rule === "R3")).toBe(true);
    expect(findings[0]?.message).toContain("does not call");
  });

  it("reports a proxy that dropped the import too", () => {
    const findings = checkProxyWiring(
      reader({ "src/proxy.ts": "export default async function proxy() {}" }),
    );
    expect(findings).toHaveLength(4);
  });

  it("reports a missing proxy", () => {
    expect(checkProxyWiring(reader({}))[0]?.message).toBe(
      "is missing entirely",
    );
  });
});

describe("R4 — header sanitising", () => {
  it("passes on the real module", () => {
    expect(checkHeaderSanitising(createFileReader(process.cwd()))).toEqual([]);
  });

  it("accepts a loop that deletes every entry", () => {
    expect(
      checkHeaderSanitising(
        reader({
          "src/lib/experiments/edge.ts": `
            for (const header of INTERNAL_REQUEST_HEADERS) headers.delete(header);
          `,
        }),
      ),
    ).toEqual([]);
  });

  it("rejects deletions written out one header at a time", () => {
    // Deliberately not accepted. The property is "all of them, by
    // construction": a list of named deletions goes on passing after a header
    // is added to the constant and not to the list.
    const findings = checkHeaderSanitising(
      reader({
        "src/lib/experiments/edge.ts": `
          headers.delete("x-geo-country");
          headers.delete("x-experiment-assignments");
        `,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R4");
  });

  it("rejects a loop that does not delete", () => {
    expect(
      checkHeaderSanitising(
        reader({
          "src/lib/experiments/edge.ts": `
            for (const header of INTERNAL_REQUEST_HEADERS) console.log(header);
          `,
        }),
      ),
    ).toHaveLength(1);
  });

  it("reports a missing module", () => {
    expect(checkHeaderSanitising(reader({}))[0]?.message).toBe(
      "is missing entirely",
    );
  });
});

describe("R5 — the variant lists", () => {
  const location = {
    experimentId: "demo",
    module: "src/app/demo/_components/variants.ts",
    constant: "DEMO_VARIANT_IDS",
  };

  const listing = (ids: string[]) =>
    `export const DEMO_VARIANT_IDS = [${ids
      .map((id) => JSON.stringify(id))
      .join(", ")}] as const;`;

  it("passes when the lists agree", () => {
    expect(
      checkVariantLists(
        reader({ [location.module]: listing(["control", "treatment"]) }),
        [ROUTED],
        [location],
      ),
    ).toEqual([]);
  });

  it("passes on the real tree", () => {
    expect(checkVariantLists(createFileReader(process.cwd()))).toEqual([]);
  });

  it("reports an arm the pages do not render", () => {
    const findings = checkVariantLists(
      reader({ [location.module]: listing(["control"]) }),
      [ROUTED],
      [location],
    );
    expect(findings[0]?.message).toContain("is missing treatment");
    expect(findings[0]?.message).toContain("not-found boundary");
  });

  it("reports an arm the registry has retired", () => {
    const findings = checkVariantLists(
      reader({ [location.module]: listing(["control", "treatment", "old"]) }),
      [ROUTED],
      [location],
    );
    expect(findings[0]?.message).toContain("lists old");
  });

  it("reports a routed experiment with no declared location", () => {
    const findings = checkVariantLists(reader({}), [ROUTED], []);
    expect(findings[0]?.message).toContain("no entry in VARIANT_LISTS");
  });

  it("reports a list that is not string literals", () => {
    const findings = checkVariantLists(
      reader({
        [location.module]: "export const DEMO_VARIANT_IDS = arms.map(f);",
      }),
      [ROUTED],
      [location],
    );
    expect(findings[0]?.message).toContain("array of string literals");
  });

  it("ignores experiments with no route", () => {
    const { route: _route, ...unrouted } = ROUTED;
    expect(checkVariantLists(reader({}), [unrouted], [])).toEqual([]);
  });
});

describe("R6 — the variant page", () => {
  const file = "src/app/demo/v/[variant]/page.tsx";
  const good = `
    export function generateStaticParams() { return []; }
    export const metadata = { robots: { index: false, follow: true } };
    export default async function Page({ params }) {
      const { variant } = await params;
      if (!isVariant(variant)) notFound();
      return null;
    }
  `;

  it("passes on a closed, non-indexed page", () => {
    expect(checkVariantPage(reader({ [file]: good }), [ROUTED])).toEqual([]);
  });

  it("passes on the real tree", () => {
    expect(checkVariantPage(createFileReader(process.cwd()))).toEqual([]);
  });

  it("reports a page that does not close the set", () => {
    // `dynamicParams = false` is rejected by cacheComponents, so notFound() is
    // what stands between /<prefix>/anything and a page rendered with an arm
    // nothing assigns.
    const findings = checkVariantPage(
      reader({ [file]: good.replace("notFound();", "") }),
      [ROUTED],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("notFound()");
  });

  it("reports a page with no generateStaticParams", () => {
    const findings = checkVariantPage(
      reader({
        [file]: good.replace(
          "export function generateStaticParams() { return []; }",
          "",
        ),
      }),
      [ROUTED],
    );
    expect(findings[0]?.message).toContain("generateStaticParams");
  });

  it("reports an indexable arm", () => {
    const findings = checkVariantPage(
      reader({ [file]: good.replace("index: false", "index: true") }),
      [ROUTED],
    );
    expect(findings[0]?.message).toContain("duplicate-content");
  });

  it("is not satisfied by a comment that quotes the rule", () => {
    // The first version of this rule was a regular expression over the file
    // text, and it passed on the real page — whose doc comment explains the
    // rule and quotes `robots: { index: false }` while the metadata said
    // otherwise. The check reads the syntax tree now.
    const findings = checkVariantPage(
      reader({
        [file]: `
          /** Must set \`robots: { index: false }\`, or the arms get indexed. */
          ${good.replace("index: false", "index: true")}
        `,
      }),
      [ROUTED],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R6");
  });

  it("reports metadata it cannot read as a literal", () => {
    // A value the gate cannot read is a value it cannot vouch for.
    const findings = checkVariantPage(
      reader({
        [file]: good.replace(
          "export const metadata = { robots: { index: false, follow: true } };",
          "export const metadata = buildMetadata();",
        ),
      }),
      [ROUTED],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("literal");
  });

  it("stays quiet about a page R2 already reported missing", () => {
    expect(checkVariantPage(reader({}), [ROUTED])).toEqual([]);
  });
});

describe("R7 — no request-scoped reads in the subtree", () => {
  it("passes on the real tree", () => {
    expect(
      checkNoRequestReads(process.cwd(), createFileReader(process.cwd())),
    ).toEqual([]);
  });

  it("reports a headers() read in an experiment's page", () => {
    // The tempting way to write this feature, and the one that gives up the
    // prerender while keeping the rewrite.
    const findings = checkNoRequestReads(process.cwd(), (relativePath) =>
      relativePath === "src/app/pricing/page.tsx"
        ? "import { headers } from 'next/headers'; export default async function P(){ const h = await headers(); return null; }"
        : createFileReader(process.cwd())(relativePath),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R7");
    expect(findings[0]?.message).toContain("headers()");
  });
});

describe("R8 — the other gates know about these routes", () => {
  it("passes on the live registry", () => {
    expect(checkGateCoverage()).toEqual([]);
  });

  it("reports a route neither gate lists", () => {
    const findings = checkGateCoverage([
      {
        ...ROUTED,
        route: {
          path: "/unlisted",
          canonicalVariantId: "control",
          rewritePrefix: "/unlisted/v",
        },
      },
    ]);
    // Two routes (canonical and variant) times two gates.
    expect(findings).toHaveLength(4);
    expect(findings.map((finding) => finding.file)).toContain(
      "scripts/assert-bundle-budget.ts",
    );
  });
});

describe("R9 — shared caches are kept off the canonical path", () => {
  const config = (value: string) => ({
    "next.config.ts": `
      const config = {
        async headers() {
          return [
            { source: "/demo", headers: [{ key: "Cache-Control", value: ${JSON.stringify(value)} }] },
          ];
        },
      };
      export default config;
    `,
  });

  it("passes on the real config", () => {
    expect(checkCacheHeaders(createFileReader(process.cwd()))).toEqual([]);
  });

  it("accepts a private, revalidating policy", () => {
    expect(
      checkCacheHeaders(reader(config("private, max-age=0, must-revalidate")), [
        ROUTED,
      ]),
    ).toEqual([]);
  });

  it("accepts no-store as the blunter answer", () => {
    expect(checkCacheHeaders(reader(config("no-store")), [ROUTED])).toEqual([]);
  });

  it("reports a canonical path with no rule at all", () => {
    // The failure nothing else can see: the prerender's own
    // `s-maxage=31536000` comes back, a CDN stores one arm under /demo, and
    // every visitor behind it is served that arm while the experiment reports
    // a split that never happened.
    const findings = checkCacheHeaders(
      reader({ "next.config.ts": "export default { output: 'standalone' };" }),
      [ROUTED],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R9");
    expect(findings[0]?.message).toContain("s-maxage=31536000");
  });

  it("reports a policy a shared cache may store", () => {
    const findings = checkCacheHeaders(reader(config("public, max-age=60")), [
      ROUTED,
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("may");
  });

  it("reports s-maxage even alongside private", () => {
    // Contradictory, and the kind of value that arrives by copying a line from
    // another route. `private` would win in a correct cache; the point is that
    // the intent is no longer legible and some caches honour the wrong half.
    const findings = checkCacheHeaders(
      reader(config("private, s-maxage=31536000")),
      [ROUTED],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("s-maxage is an instruction");
  });

  it("reports a rule that sets some other header instead", () => {
    const findings = checkCacheHeaders(
      reader({
        "next.config.ts": `
          const config = {
            async headers() {
              return [{ source: "/demo", headers: [{ key: "Vary", value: "Cookie" }] }];
            },
          };
          export default config;
        `,
      }),
      [ROUTED],
    );
    expect(findings[0]?.message).toContain("sets no Cache-Control");
  });

  it("ignores experiments with no route", () => {
    const { route: _unused, ...unrouted } = ROUTED;
    expect(
      checkCacheHeaders(reader({ "next.config.ts": "export default {};" }), [
        { ...unrouted, id: "headless" },
      ]),
    ).toEqual([]);
  });

  it("reports a missing config", () => {
    expect(checkCacheHeaders(reader({}))[0]?.message).toBe(
      "is missing entirely",
    );
  });
});

describe("configHeaderRules", () => {
  const source = (text: string) =>
    ts.createSourceFile("next.config.ts", text, ts.ScriptTarget.ES2022, true);

  it("reads a rule out of the config", () => {
    expect(
      configHeaderRules(
        source(
          'export default { async headers() { return [{ source: "/a", headers: [{ key: "K", value: "V" }] }]; } };',
        ),
      ),
    ).toEqual([{ source: "/a", headers: [{ key: "K", value: "V" }] }]);
  });

  it("reads several rules", () => {
    expect(
      configHeaderRules(
        source(
          "export default { async headers() { return [" +
            '{ source: "/a", headers: [] },' +
            '{ source: "/b", headers: [] }]; } };',
        ),
      ).map((rule) => rule.source),
    ).toEqual(["/a", "/b"]);
  });

  it("skips a rule whose source is computed", () => {
    // Unreadable is reported as missing, never as satisfied.
    expect(
      configHeaderRules(
        source(
          "export default { async headers() { return [{ source: path, headers: [] }]; } };",
        ),
      ),
    ).toEqual([]);
  });

  it("skips a header whose value is computed", () => {
    expect(
      configHeaderRules(
        source(
          'export default { async headers() { return [{ source: "/a", headers: [{ key: "K", value: v }] }]; } };',
        ),
      ),
    ).toEqual([{ source: "/a", headers: [] }]);
  });

  it("finds nothing in a config with no headers block", () => {
    expect(
      configHeaderRules(source("export default { output: 'standalone' };")),
    ).toEqual([]);
  });
});

describe("the AST helpers", () => {
  const source = (text: string) =>
    ts.createSourceFile("m.ts", text, ts.ScriptTarget.ES2022, true);

  it("reads an exported `as const` string array", () => {
    expect(
      exportedStringArray(
        source('export const IDS = ["a", "b"] as const;'),
        "IDS",
      ),
    ).toEqual(["a", "b"]);
  });

  it("reads a plain array too", () => {
    expect(
      exportedStringArray(source('export const IDS = ["a"];'), "IDS"),
    ).toEqual(["a"]);
  });

  it("refuses an array it cannot read statically", () => {
    // A computed list is not something this gate can check, and treating it as
    // satisfying the rule is how a check passes on code it never understood.
    expect(
      exportedStringArray(source("export const IDS = other.map(f);"), "IDS"),
    ).toBeUndefined();
    expect(
      exportedStringArray(source("export const IDS = [a, b];"), "IDS"),
    ).toBeUndefined();
  });

  it("returns undefined for a name that is not there", () => {
    expect(
      exportedStringArray(source('export const OTHER = ["a"];'), "IDS"),
    ).toBeUndefined();
  });

  it("reads metadata.robots.index when it is a literal", () => {
    expect(
      metadataRobotsIndex(
        source("export const metadata = { robots: { index: false } };"),
      ),
    ).toBe(false);
    expect(
      metadataRobotsIndex(
        source("export const metadata = { robots: { index: true } };"),
      ),
    ).toBe(true);
  });

  it("returns undefined when there is no literal to read", () => {
    expect(
      metadataRobotsIndex(source("export const metadata = {};")),
    ).toBeUndefined();
    expect(
      metadataRobotsIndex(source("export const metadata = { robots: r };")),
    ).toBeUndefined();
    expect(
      metadataRobotsIndex(
        source("export const metadata = { robots: { index: flag } };"),
      ),
    ).toBeUndefined();
    expect(
      metadataRobotsIndex(source("export function generateMetadata() {}")),
    ).toBeUndefined();
  });

  it("recognises exported functions and consts, and only exported ones", () => {
    expect(
      exportsName(
        source("export function generateStaticParams() {}"),
        "generateStaticParams",
      ),
    ).toBe(true);
    expect(
      exportsName(
        source("export const generateStaticParams = () => {};"),
        "generateStaticParams",
      ),
    ).toBe(true);
    expect(
      exportsName(
        source("function generateStaticParams() {}"),
        "generateStaticParams",
      ),
    ).toBe(false);
    expect(
      exportsName(source("export function other() {}"), "generateStaticParams"),
    ).toBe(false);
  });
});
