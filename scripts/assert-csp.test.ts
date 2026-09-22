import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { MANIFEST_VERSION } from "@/lib/security/shell-hashes";
import { buildPolicy, parsePolicy } from "@/lib/security/csp";
import type { ShellHashManifest } from "@/lib/security/shell-hashes";
import {
  FORBIDDEN_SCRIPT_SOURCES,
  REQUIRED_DIRECTIVES,
  browserModules,
  checkCatalogueAgreement,
  checkCsp,
  checkDocuments,
  checkForbiddenSources,
  checkManifestFreshness,
  checkProxyWiring,
  checkRegenerationDerivation,
  checkRelaxedPolicy,
  checkRequiredDirectives,
  checkZodJitProbe,
  externalScripts,
  requestPathFor,
  withoutComments,
} from "./assert-csp";
import type { PrerenderedDocument } from "./emit-csp-hashes";

const sha256 = (body: string): string =>
  createHash("sha256").update(body, "utf8").digest("base64");

function document(route: string, ...bodies: string[]): PrerenderedDocument {
  return {
    route,
    html:
      '<script src="/_next/static/chunks/main.js" async=""></script>' +
      bodies.map((body) => `<script>${body}</script>`).join(""),
  };
}

const HOME = document("/", "home-a", "home-b");
const BLOG = document("/blog", "blog-a");

function manifest(
  overrides: Partial<ShellHashManifest> = {},
): ShellHashManifest {
  return {
    version: MANIFEST_VERSION,
    buildId: "build-1",
    universal: [],
    exact: {
      "/": {
        hashes: [sha256("home-a"), sha256("home-b")],
        regenerates: false,
      },
      "/blog": { hashes: [sha256("blog-a")], regenerates: true },
    },
    dynamic: [],
    ...overrides,
  };
}

const NONCE = "GateNonceNotInAnyDocument==";

const PROXY_SOURCE = `
  const csp = decideCsp(request, { served: experiments.rewrite?.to });
  const requestHeaders = applyCspRequestHeaders(sanitised, csp);
  return applyCspHeaders(response, csp);
`;

describe("checkDocuments", () => {
  it("passes when every script in every document is authorised", () => {
    expect(checkDocuments([HOME, BLOG], manifest())).toEqual([]);
  });

  it("fails when a digest is missing, and names the document", () => {
    const incomplete = manifest({
      exact: {
        "/": { hashes: [sha256("home-a")], regenerates: false },
        "/blog": { hashes: [], regenerates: true },
      },
    });

    const [violation] = checkDocuments([HOME, BLOG], incomplete);
    expect(violation?.problem).toContain("1 inline script");
    expect(violation?.problem).toContain("home-b");
  });

  it("passes a regenerating document with no digests at all", () => {
    // Its policy is `'self' 'unsafe-inline'`, which is the point: a revalidation
    // writes inline scripts no digest from this build could cover.
    const noBlogDigests = manifest({
      exact: {
        "/": {
          hashes: [sha256("home-a"), sha256("home-b")],
          regenerates: false,
        },
        "/blog": { hashes: [], regenerates: true },
      },
    });
    expect(checkDocuments([BLOG], noBlogDigests)).toEqual([]);
  });

  it("looks a dynamic shell up the way a request path would", () => {
    // The manifest keys dynamic shells by regex, so a lookup by the literal
    // `/blog/[slug]` would find nothing and prove nothing.
    const shell = document("/blog/[slug]", "shell");
    const withDynamic = manifest({
      dynamic: [
        {
          route: "/blog/[slug]",
          regex: "^/blog/([^/]+?)(?:/)?$",
          hashes: [sha256("shell")],
          regenerates: false,
        },
      ],
    });

    expect(requestPathFor(shell)).toBe("/blog/csp-gate-probe");
    expect(checkDocuments([shell], withDynamic)).toEqual([]);
  });

  it("fails when a dynamic route's regex cannot match a request path", () => {
    // The `(.)photos/[id]` regex out of the prerender manifest is literally
    // `^/\(\.\)photos/…`, which no browser ever sends.
    const shell = document("/photos/[id]", "shell");
    const unmatchable = manifest({
      dynamic: [
        {
          route: "/photos/[id]",
          regex: String.raw`^/\(\.\)photos/([^/]+?)$`,
          hashes: [sha256("shell")],
          regenerates: false,
        },
      ],
    });

    expect(checkDocuments([shell], unmatchable)).not.toEqual([]);
  });
});

describe("checkForbiddenSources", () => {
  it("passes the policy this repository builds", () => {
    expect(
      checkForbiddenSources(
        parsePolicy(
          buildPolicy({
            nonce: NONCE,
            mode: "production",
            secure: true,
            thirdParty: {},
          }),
        ),
      ),
    ).toEqual([]);
  });

  it("fails on each forbidden source", () => {
    for (const { source } of FORBIDDEN_SCRIPT_SOURCES) {
      const violations = checkForbiddenSources(
        parsePolicy(`script-src 'self' ${source}`),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.problem).toContain(source);
    }
  });
});

describe("checkRelaxedPolicy", () => {
  it("passes for the relaxed policy this repository builds", () => {
    expect(checkRelaxedPolicy(manifest(), NONCE)).toEqual([]);
  });

  it("is silent when nothing regenerates", () => {
    const fixed = manifest({
      exact: { "/": { hashes: [], regenerates: false } },
    });
    expect(checkRelaxedPolicy(fixed, NONCE)).toEqual([]);
  });
});

describe("checkRegenerationDerivation", () => {
  const prerenderManifest = {
    routes: {
      "/": { initialRevalidateSeconds: false },
      "/blog": { initialRevalidateSeconds: 60 },
    },
    dynamicRoutes: {},
  };

  it("passes when the marking matches the build", () => {
    expect(checkRegenerationDerivation(manifest(), prerenderManifest)).toEqual(
      [],
    );
  });

  it("fails when a revalidating route is left strict", () => {
    // The failure with no symptom until the first revalidation: minutes after a
    // deploy, on a route nobody re-tests, every script stops being authorised.
    const wrong = manifest({
      exact: {
        "/": { hashes: [], regenerates: false },
        "/blog": { hashes: [], regenerates: false },
      },
    });

    const [violation] = checkRegenerationDerivation(wrong, prerenderManifest);
    expect(violation?.problem).toContain("/blog");
    expect(violation?.problem).toContain("revalidation window");
  });

  it("fails when a fixed route is handed the relaxation", () => {
    const wrong = manifest({
      exact: {
        "/": { hashes: [], regenerates: true },
        "/blog": { hashes: [], regenerates: true },
      },
    });

    const violations = checkRegenerationDerivation(wrong, prerenderManifest);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("/`");
  });

  it("accepts a prerendered instance of a revalidating dynamic route", () => {
    // `/blog/seed-post` has no window of its own; it inherits its pattern's.
    const withInstance = manifest({
      exact: {
        "/": { hashes: [], regenerates: false },
        "/blog": { hashes: [], regenerates: true },
        "/blog/seed-post": { hashes: [], regenerates: true },
      },
      dynamic: [
        {
          route: "/blog/[slug]",
          regex: "^/blog/([^/]+?)(?:/)?$",
          hashes: [],
          regenerates: true,
        },
      ],
    });

    expect(
      checkRegenerationDerivation(withInstance, {
        ...prerenderManifest,
        dynamicRoutes: { "/blog/[slug]": { initialRevalidateSeconds: 300 } },
      }),
    ).toEqual([]);
  });
});

describe("checkRequiredDirectives", () => {
  it("passes the policy this repository builds", () => {
    expect(
      checkRequiredDirectives(
        parsePolicy(
          buildPolicy({
            nonce: NONCE,
            mode: "production",
            secure: true,
            thirdParty: {},
          }),
        ),
      ),
    ).toEqual([]);
  });

  it("fails on a missing directive and on a weakened one", () => {
    for (const { name } of REQUIRED_DIRECTIVES) {
      expect(
        checkRequiredDirectives(parsePolicy("img-src 'self'")),
      ).not.toEqual([]);
      expect(
        checkRequiredDirectives(parsePolicy(`${name} 'unsafe-inline'`)),
      ).not.toEqual([]);
    }
  });
});

describe("checkCatalogueAgreement", () => {
  it("passes: the policy's origins come from the catalogue", () => {
    expect(checkCatalogueAgreement(NONCE)).toEqual([]);
  });
});

describe("checkProxyWiring", () => {
  it("passes on a proxy that applies the policy to request and response", () => {
    expect(checkProxyWiring(PROXY_SOURCE)).toEqual([]);
  });

  it("fails when the request half goes missing", () => {
    // The subtle half: Next reads the nonce from the *request*, so a policy set
    // only on the response nonces nothing and every dynamic hole loses its
    // authorisation with no other symptom.
    const responseOnly = PROXY_SOURCE.replace(
      "applyCspRequestHeaders(sanitised, csp)",
      "sanitised",
    );
    const [violation] = checkProxyWiring(responseOnly);
    expect(violation?.problem).toContain("applyCspRequestHeaders");
  });

  it("fails when the policy is never built or never sent", () => {
    expect(checkProxyWiring("")).toHaveLength(3);
  });
});

describe("checkZodJitProbe", () => {
  const zodModule = (body: string): { relativePath: string; text: string } => ({
    relativePath: "src/lib/thing.ts",
    text: `import { z } from "zod";\n${body}`,
  });

  it("passes when the guard is above the first schema", () => {
    expect(
      checkZodJitProbe([
        zodModule("disableZodJitInBrowser();\nconst s = z.object({});"),
      ]),
    ).toEqual([]);
  });

  it("fails when the guard is missing", () => {
    expect(
      checkZodJitProbe([zodModule("const s = z.object({});")]),
    ).toHaveLength(1);
  });

  it("fails when the guard is below the schema, where it configures nothing", () => {
    const [violation] = checkZodJitProbe([
      zodModule("const s = z.object({});\ndisableZodJitInBrowser();"),
    ]);
    expect(violation?.problem).toContain("after its first schema");
  });

  it("sees a schema written as a method chain", () => {
    // `z\n  .object({…})` is how this repository writes the larger schemas, and a
    // pattern that missed it missed the module that actually fired the probe.
    expect(
      checkZodJitProbe([zodModule("const s = z\n  .object({})\n  .strict();")]),
    ).toHaveLength(1);
  });

  it("ignores a module that builds no object schema", () => {
    expect(checkZodJitProbe([zodModule("const s = z.string();")])).toEqual([]);
  });

  it("is not fooled by the word z.object() in a comment", () => {
    // The prose explaining the guard says `z.object()`, and a positional check
    // reading the raw text finds it above the call.
    expect(
      checkZodJitProbe([
        zodModule(
          "/** builds a z.object() in the browser */\ndisableZodJitInBrowser();\nconst s = z.object({});",
        ),
      ]),
    ).toEqual([]);
  });
});

describe("withoutComments", () => {
  it("blanks comments and keeps every offset", () => {
    const source = "a; // z.object(\nb; /* z.object( */ c;";
    const stripped = withoutComments(source);
    expect(stripped).toHaveLength(source.length);
    expect(stripped).not.toContain("z.object(");
    expect(stripped.indexOf("b;")).toBe(source.indexOf("b;"));
  });

  it("leaves a comment marker inside a string alone", () => {
    expect(withoutComments('const u = "https://x/y";')).toContain(
      '"https://x/y"',
    );
  });

  it("handles an unterminated block comment", () => {
    expect(withoutComments("a; /* never closed").trim()).toBe("a;");
  });
});

describe("browserModules", () => {
  it("stops at a server boundary", () => {
    // A client component importing a Server Action does not ship that action's
    // code to the browser, so its schemas are not a browser's problem. Following
    // it anyway produced ten findings, all false.
    const files = [
      { relativePath: "src/a.tsx", text: '"use client";\nimport "@/action";' },
      {
        relativePath: "src/action.ts",
        text: '"use server";\nimport "@/schema";',
      },
      { relativePath: "src/schema.ts", text: 'import { z } from "zod";' },
    ];

    expect(browserModules(files).map((file) => file.relativePath)).toEqual([
      "src/a.tsx",
    ]);
  });

  it("follows an ordinary import from a client entry", () => {
    const files = [
      { relativePath: "src/a.tsx", text: '"use client";\nimport "@/helper";' },
      { relativePath: "src/helper.ts", text: "export const x = 1;" },
      { relativePath: "src/unreached.ts", text: "export const y = 2;" },
    ];

    expect(browserModules(files).map((file) => file.relativePath)).toEqual([
      "src/a.tsx",
      "src/helper.ts",
    ]);
  });

  it("sees a directive under a licence comment", () => {
    const files = [
      {
        relativePath: "src/a.tsx",
        text: '/* header */\n"use client";\nimport "@/helper";',
      },
      { relativePath: "src/helper.ts", text: "export const x = 1;" },
    ];

    expect(browserModules(files)).toHaveLength(2);
  });
});

describe("externalScripts", () => {
  it("lists the src of every fetched script", () => {
    expect(externalScripts(HOME.html)).toEqual([
      "/_next/static/chunks/main.js",
    ]);
  });

  it("ignores an inline tag", () => {
    expect(externalScripts("<script>a=1</script>")).toEqual([]);
  });
});

describe("checkManifestFreshness", () => {
  it("passes when the manifest is this build's", () => {
    expect(checkManifestFreshness(manifest(), "build-1")).toEqual([]);
  });

  it("fails on a manifest from another build", () => {
    const [violation] = checkManifestFreshness(manifest(), "build-2");
    expect(violation?.problem).toContain("build-1");
    expect(violation?.problem).toContain("build-2");
  });
});

describe("checkCsp", () => {
  const input = {
    documents: [HOME, BLOG],
    manifest: manifest(),
    buildId: "build-1",
    proxySource: PROXY_SOURCE,
    clientGraph: [],
    prerenderManifest: {
      routes: {
        "/": { initialRevalidateSeconds: false },
        "/blog": { initialRevalidateSeconds: 60 },
      },
    },
  };

  it("passes a coherent build", () => {
    expect(checkCsp(input)).toEqual([]);
  });

  it("reports only the missing manifest when there is none", () => {
    // Everything else would fail too, and all of it for one reason.
    const violations = checkCsp({ ...input, manifest: undefined });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("csp-shell-hashes.json");
  });
});
