import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { http, passthrough } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server as mswServer } from "@/test/server";
import {
  ALLOWED_INCOMPLETE,
  ALLOWED_VIOLATIONS,
  DOCUMENTS_WITHOUT_THEME_CLASS,
  REQUIRED_DOCUMENTS,
  RULES_THAT_MUST_RUN,
  THEMES,
  WCAG_TAGS,
  auditDocuments,
  buildReport,
  covers,
  createAssetServer,
  discoverDocuments,
  formatReport,
  missingDocuments,
  reportIsClean,
  routeForFile,
  type Allowance,
  type AuditTarget,
  type AxeResult,
  type DocumentAudit,
  type Theme,
} from "./assert-accessibility";

/**
 * Styling that passes every non-vacuity check, so a case about rules is not
 * also a case about whether the stylesheet loaded.
 */
const STYLED = {
  stylesheetRules: 412,
  bodyBackgroundColor: "rgb(255, 255, 255)",
  themeClassApplied: true,
};

function result(overrides: Partial<AxeResult> = {}): AxeResult {
  return {
    id: "color-contrast",
    impact: "serious",
    help: "Elements must meet minimum color contrast ratio thresholds",
    nodes: [{ target: ["a"], html: '<a href="/register">Create one</a>' }],
    ...overrides,
  };
}

/**
 * One audited document/theme pair. `passes` defaults to the two rules the gate
 * insists were evaluated somewhere, so a case about a violation does not also
 * trip `rulesThatDidNotRun`.
 */
function audit(overrides: Partial<DocumentAudit> = {}): DocumentAudit {
  return {
    route: "/login",
    theme: "light",
    styling: { ...STYLED },
    run: {
      violations: [],
      incomplete: [],
      passes: RULES_THAT_MUST_RUN.map((id) => ({ id })),
    },
    ...overrides,
  };
}

/** Every required document, so a case can be about one thing at a time. */
function allRequired(): AuditTarget[] {
  return REQUIRED_DOCUMENTS.map((route) => ({ route, file: `${route}.html` }));
}

function reportFor(
  audits: readonly DocumentAudit[],
  options: Parameters<typeof buildReport>[2] = {},
) {
  return buildReport(audits, allRequired(), {
    allowedViolations: [],
    allowedIncomplete: [],
    ...options,
  });
}

describe("WCAG_TAGS", () => {
  it("covers level A and AA up to WCAG 2.2 and nothing beyond it", () => {
    expect([...WCAG_TAGS]).toEqual([
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22a",
      "wcag22aa",
    ]);
    // `best-practice` is axe's advice rather than the standard, and a gate that
    // fails on advice is a gate people route around.
    expect([...WCAG_TAGS]).not.toContain("best-practice");
    // AAA is not the target, and asserting it here keeps a well-meaning
    // addition from quietly changing what "AA gate" means.
    expect(WCAG_TAGS.some((tag) => tag.endsWith("aaa"))).toBe(false);
  });
});

describe("routeForFile", () => {
  it("maps the build's file layout onto URL paths", () => {
    const app = path.join("/build", ".next", "server", "app");

    expect(routeForFile(app, path.join(app, "index.html"))).toBe("/");
    expect(routeForFile(app, path.join(app, "login.html"))).toBe("/login");
    expect(routeForFile(app, path.join(app, "blog", "[slug].html"))).toBe(
      "/blog/[slug]",
    );
    expect(routeForFile(app, path.join(app, "settings", "security.html"))).toBe(
      "/settings/security",
    );
    // The intercepted modal slot, which is a document like any other.
    expect(routeForFile(app, path.join(app, "(.)photos", "[id].html"))).toBe(
      "/(.)photos/[id]",
    );
  });
});

describe("discoverDocuments", () => {
  const made: string[] = [];

  afterEach(() => {
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tree(files: readonly string[]): string {
    const root = mkdtempSync(path.join(tmpdir(), "a11y-gate-"));
    made.push(root);
    for (const file of files) {
      const absolute = path.join(root, file);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, "<!doctype html>");
    }
    return root;
  }

  it("finds every prerendered document, at any depth, in a stable order", () => {
    const root = tree([
      "login.html",
      "index.html",
      "settings/security.html",
      "blog/[slug].html",
    ]);

    expect(discoverDocuments(root).map((d) => d.route)).toEqual([
      "/",
      "/blog/[slug]",
      "/login",
      "/settings/security",
    ]);
  });

  it("ignores the build's other output next to the documents", () => {
    const root = tree(["login.html", "login.meta", "login.rsc", "page.js"]);

    expect(discoverDocuments(root).map((d) => d.route)).toEqual(["/login"]);
  });

  it("returns nothing rather than throwing when there is no build", () => {
    expect(discoverDocuments(path.join(tmpdir(), "a11y-gate-absent"))).toEqual(
      [],
    );
  });
});

describe("missingDocuments", () => {
  it("names a required route that stopped prerendering", () => {
    const found = allRequired().filter((t) => t.route !== "/dashboard");

    expect(missingDocuments(found)).toEqual(["/dashboard"]);
  });

  it("is satisfied by extra documents it does not know about", () => {
    const found = [
      ...allRequired(),
      { route: "/blog/a-seeded-post", file: "x" },
    ];

    expect(missingDocuments(found)).toEqual([]);
  });
});

describe("covers", () => {
  const allowance: Allowance = {
    route: "/blog/[slug]",
    rule: "document-title",
    because: "the fallback shell has no slug yet",
  };

  it("matches the rule on the route it was written for", () => {
    expect(
      covers(
        allowance,
        "/blog/[slug]",
        "light",
        result({ id: "document-title" }),
      ),
    ).toBe(true);
  });

  it("does not spill onto another rule or another route", () => {
    expect(covers(allowance, "/blog/[slug]", "light", result())).toBe(false);
    expect(
      covers(allowance, "/blog", "light", result({ id: "document-title" })),
    ).toBe(false);
  });

  it("matches a family of routes by pattern", () => {
    const seeded: Allowance = {
      route: /^\/blog\/(?!\[)/,
      rule: "color-contrast",
      because: "the caption sits on a gradient",
    };

    expect(
      covers(seeded, "/blog/seed-post-cache-life", "light", result()),
    ).toBe(true);
    // The shell is spelled `[slug]` and is deliberately outside the pattern.
    expect(covers(seeded, "/blog/[slug]", "light", result())).toBe(false);
  });

  it("stays inside its theme when one is named", () => {
    const darkOnly: Allowance = {
      route: "/login",
      rule: "color-contrast",
      theme: "dark",
      because: "a token that is only this wrong in the dark palette",
    };

    expect(covers(darkOnly, "/login", "dark", result())).toBe(true);
    expect(covers(darkOnly, "/login", "light", result())).toBe(false);
  });

  it("only covers a result whose every node is the markup it describes", () => {
    const gradient: Allowance = {
      route: "/blog/post",
      rule: "color-contrast",
      htmlIncludes: "bg-gradient-to-t",
      because: "axe cannot measure a gradient",
    };
    const caption = {
      target: ["span"],
      html: '<span class="bg-gradient-to-t">Me at the zoo</span>',
    };

    expect(
      covers(gradient, "/blog/post", "light", result({ nodes: [caption] })),
    ).toBe(true);
    // A second element failing the same rule on the same page is a new
    // regression, and an exemption for the caption must not absorb it.
    expect(
      covers(
        gradient,
        "/blog/post",
        "light",
        result({
          nodes: [caption, { target: ["a"], html: '<a href="/">Home</a>' }],
        }),
      ),
    ).toBe(false);
  });
});

describe("buildReport", () => {
  it("passes a build with nothing wrong in it", () => {
    const report = reportFor(THEMES.map((theme) => audit({ theme })));

    expect(report.findings).toEqual([]);
    expect(reportIsClean(report)).toBe(true);
    expect(report.audited).toBe(2);
  });

  it("reports a violation with the route and theme it was found in", () => {
    const report = reportFor([
      audit({ theme: "dark" }),
      audit({
        theme: "light",
        run: {
          violations: [result()],
          incomplete: [],
          passes: RULES_THAT_MUST_RUN.map((id) => ({ id })),
        },
      }),
    ]);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      route: "/login",
      theme: "light",
      rule: "color-contrast",
      kind: "violation",
    });
    expect(reportIsClean(report)).toBe(false);
  });

  it("fails on an undeclared incomplete result", () => {
    // The gate's sharpest edge. The wrong green this file documents reported no
    // violations and twenty-two incompletes, because the stylesheet had not
    // loaded and axe could not measure anything.
    const report = reportFor([
      ...THEMES.map((theme) => audit({ theme })),
      audit({
        run: {
          violations: [],
          incomplete: [result()],
          passes: RULES_THAT_MUST_RUN.map((id) => ({ id })),
        },
      }),
    ]);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.kind).toBe("incomplete");
  });

  it("suppresses a finding an allowance was written for", () => {
    const allowance: Allowance = {
      route: "/login",
      rule: "color-contrast",
      because: "reviewed by hand",
    };
    const report = reportFor(
      [
        audit({ theme: "dark" }),
        audit({
          run: {
            violations: [result()],
            incomplete: [],
            passes: RULES_THAT_MUST_RUN.map((id) => ({ id })),
          },
        }),
      ],
      { allowedViolations: [allowance] },
    );

    expect(report.findings).toEqual([]);
    expect(report.staleAllowances).toEqual([]);
    expect(reportIsClean(report)).toBe(true);
  });

  it("fails on an allowance that no longer matches anything", () => {
    const stale: Allowance = {
      route: "/login",
      rule: "color-contrast",
      because: "a contrast failure that has since been fixed",
    };
    const report = reportFor(
      THEMES.map((theme) => audit({ theme })),
      {
        allowedViolations: [stale],
      },
    );

    expect(report.findings).toEqual([]);
    expect(report.staleAllowances).toEqual([stale]);
    // An exemption nobody needs is a hole waiting for the next regression, so
    // this is a failure and not a warning.
    expect(reportIsClean(report)).toBe(false);
  });

  it("fails when a required route prerendered no document", () => {
    const report = buildReport(
      THEMES.map((theme) => audit({ theme })),
      allRequired().filter((t) => t.route !== "/admin"),
      { allowedViolations: [], allowedIncomplete: [] },
    );

    expect(report.missingDocuments).toEqual(["/admin"]);
    expect(reportIsClean(report)).toBe(false);
  });

  describe("non-vacuity", () => {
    it("fails when the browser parsed no CSS at all", () => {
      const report = reportFor(
        THEMES.map((theme) =>
          audit({ theme, styling: { ...STYLED, stylesheetRules: 0 } }),
        ),
      );

      expect(report.unstyled).toHaveLength(2);
      expect(report.unstyled[0]?.problem).toContain("no CSS rules");
      expect(reportIsClean(report)).toBe(false);
    });

    it("fails when `body` has no resolved background to measure against", () => {
      for (const transparent of ["transparent", "rgba(0, 0, 0, 0)"]) {
        const report = reportFor(
          THEMES.map((theme) =>
            audit({
              theme,
              styling: { ...STYLED, bodyBackgroundColor: transparent },
            }),
          ),
        );

        expect(report.unstyled, transparent).toHaveLength(2);
        expect(reportIsClean(report)).toBe(false);
      }
    });

    it("accepts an opaque background", () => {
      const report = reportFor(
        THEMES.map((theme) =>
          audit({
            theme,
            styling: { ...STYLED, bodyBackgroundColor: "rgba(10, 10, 10, 1)" },
          }),
        ),
      );

      expect(report.unstyled).toEqual([]);
    });

    it("fails when the theme never reached `<html>`", () => {
      // Otherwise the dark pass is a second light pass and says so nowhere.
      const report = reportFor(
        THEMES.map((theme) =>
          audit({ theme, styling: { ...STYLED, themeClassApplied: false } }),
        ),
      );

      expect(report.unstyled).toHaveLength(2);
      expect(report.unstyled[0]?.problem).toContain("theme class");
    });

    it("excuses the documents declared to have no theme class", () => {
      const report = reportFor(
        THEMES.map((theme) =>
          audit({
            route: "/_global-error",
            theme,
            styling: { ...STYLED, themeClassApplied: false },
          }),
        ),
        { withoutThemeClass: ["/_global-error"] },
      );

      expect(report.unstyled).toEqual([]);
      expect(report.themedDespiteExemption).toEqual([]);
    });

    it("fails when such a document turns out to have the class after all", () => {
      const report = reportFor(
        THEMES.map((theme) => audit({ route: "/_global-error", theme })),
        { withoutThemeClass: ["/_global-error"] },
      );

      expect(report.themedDespiteExemption).toEqual(["/_global-error"]);
      expect(reportIsClean(report)).toBe(false);
    });

    it("fails when a rule that needs a laid-out page never ran", () => {
      // jsdom's signature: every colour and size result comes back unusable,
      // and the run still reports zero violations.
      const report = reportFor(
        THEMES.map((theme) =>
          audit({
            theme,
            run: {
              violations: [],
              incomplete: [],
              passes: [{ id: "html-has-lang" }],
            },
          }),
        ),
      );

      expect(report.rulesThatDidNotRun).toEqual([
        { theme: "light", rule: "color-contrast" },
        { theme: "light", rule: "target-size" },
        { theme: "dark", rule: "color-contrast" },
        { theme: "dark", rule: "target-size" },
      ]);
      expect(reportIsClean(report)).toBe(false);
    });

    it("counts a rule as evaluated when it ran and failed, not only when it passed", () => {
      const report = reportFor(
        THEMES.map((theme) =>
          audit({
            theme,
            run: {
              violations: [result({ id: "color-contrast" })],
              incomplete: [result({ id: "target-size" })],
              passes: [],
            },
          }),
        ),
      );

      expect(report.rulesThatDidNotRun).toEqual([]);
      // The findings themselves are still findings.
      expect(report.findings).toHaveLength(4);
    });

    it("needs the rule in each theme separately", () => {
      const report = reportFor([
        audit({ theme: "light" }),
        audit({
          theme: "dark",
          run: {
            violations: [],
            incomplete: [],
            passes: [{ id: "html-has-lang" }],
          },
        }),
      ]);

      expect(report.rulesThatDidNotRun).toEqual([
        { theme: "dark", rule: "color-contrast" },
        { theme: "dark", rule: "target-size" },
      ]);
    });
  });
});

describe("formatReport", () => {
  it("prints the route, theme, rule and offending markup", () => {
    const report = reportFor([
      audit({ theme: "dark" }),
      audit({
        run: {
          violations: [
            result({
              nodes: [
                {
                  target: ["a"],
                  html: '<a style="color:var(--primary)">Create one</a>',
                  failureSummary: "Fix any of the following:\n  contrast 4.37",
                },
              ],
            }),
          ],
          incomplete: [],
          passes: RULES_THAT_MUST_RUN.map((id) => ({ id })),
        },
      }),
    ]);

    const text = formatReport(report);

    expect(text).toContain("/login [light] color-contrast");
    expect(text).toContain("var(--primary)");
    expect(text).toContain("contrast 4.37");
  });

  it("explains a stale allowance with the reason it was written for", () => {
    const report = reportFor(
      THEMES.map((theme) => audit({ theme })),
      {
        allowedIncomplete: [
          {
            route: "/posts/[id]",
            rule: "bypass",
            because: "the nav subtree streams in this fallback shell",
          },
        ],
      },
    );

    expect(formatReport(report)).toContain(
      "the nav subtree streams in this fallback shell",
    );
  });

  it("is empty for a clean report, so a passing run prints nothing", () => {
    expect(
      formatReport(reportFor(THEMES.map((theme) => audit({ theme })))),
    ).toBe("");
  });
});

describe("auditDocuments", () => {
  it("audits every document in every theme", async () => {
    const seen: string[] = [];
    const audits = await auditDocuments(
      async (target, theme) => {
        seen.push(`${target.route}:${theme}`);
        return audit({ route: target.route, theme });
      },
      [
        { route: "/", file: "index.html" },
        { route: "/login", file: "login.html" },
      ],
    );

    expect(seen).toEqual(["/:light", "/login:light", "/:dark", "/login:dark"]);
    expect(audits).toHaveLength(4);
  });
});

describe("createAssetServer", () => {
  const made: string[] = [];

  // The unit setup installs MSW with `onUnhandledRequest: "warn"`, and these
  // cases are the only ones in the repository that make a real request to a
  // real socket. Without this they each print an interception warning, which is
  // noise in front of whatever the next genuine failure is.
  beforeEach(() => {
    mswServer.use(http.all(/127\.0\.0\.1/, () => passthrough()));
  });

  afterEach(() => {
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function buildOutput(): string {
    const root = mkdtempSync(path.join(tmpdir(), "a11y-server-"));
    made.push(root);
    const app = path.join(root, "server", "app");
    mkdirSync(path.join(app, "blog"), { recursive: true });
    mkdirSync(path.join(root, "static", "chunks"), { recursive: true });
    writeFileSync(path.join(app, "index.html"), "<!doctype html><title>home");
    writeFileSync(
      path.join(app, "blog", "[slug].html"),
      "<!doctype html><title>shell",
    );
    writeFileSync(
      path.join(root, "static", "chunks", "app.css"),
      "body{color:red}",
    );
    writeFileSync(path.join(root, "secret.txt"), "not part of the documents");
    return root;
  }

  async function get(origin: string, requestPath: string) {
    const response = await fetch(`${origin}${requestPath}`);
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      body: await response.text(),
    };
  }

  it("serves documents as HTML and assets with their own media type", async () => {
    const { server, listen } = createAssetServer(buildOutput());
    const origin = await listen();
    try {
      const home = await get(origin, "/");
      expect(home.status).toBe(200);
      // Without this the browser downloads the document instead of rendering it.
      expect(home.type).toContain("text/html");
      expect(home.body).toContain("home");

      const css = await get(origin, "/_next/static/chunks/app.css");
      expect(css.status).toBe(200);
      expect(css.type).toBe("text/css");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("serves a dynamic segment's shell under its bracketed path", async () => {
    const { server, listen } = createAssetServer(buildOutput());
    const origin = await listen();
    try {
      const shell = await get(origin, encodeURI("/blog/[slug]"));

      expect(shell.status).toBe(200);
      expect(shell.body).toContain("shell");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("serves nothing from outside the build output", async () => {
    const { server, listen } = createAssetServer(buildOutput());
    const origin = await listen();
    try {
      for (const escape of [
        "/_next/static/../../secret.txt",
        "/_next/static/%2e%2e/%2e%2e/secret.txt",
      ]) {
        const escaped = await get(origin, escape);
        expect(escaped.status, escape).toBe(404);
        expect(escaped.body, escape).not.toContain("not part of the documents");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("answers an unknown document with a 404 the runner refuses to audit", async () => {
    const { server, listen } = createAssetServer(buildOutput());
    const origin = await listen();
    try {
      expect((await get(origin, "/nope")).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("the tables this gate ships with", () => {
  it("gives every allowance a reason", () => {
    for (const allowance of [...ALLOWED_VIOLATIONS, ...ALLOWED_INCOMPLETE]) {
      expect(allowance.because.length, allowance.rule).toBeGreaterThan(20);
    }
  });

  it("requires the documents the application is expected to prerender", () => {
    // The four fallback shells in particular: they are the documents most
    // likely to lose their place in the audit, because nothing visible changes
    // when a dynamic segment stops prerendering one.
    expect(REQUIRED_DOCUMENTS).toContain("/blog/[slug]");
    expect(REQUIRED_DOCUMENTS).toContain("/photos/[id]");
    expect(REQUIRED_DOCUMENTS).toContain("/posts/[id]");
    expect(REQUIRED_DOCUMENTS).toContain("/pricing/v/[variant]");
    expect(new Set(REQUIRED_DOCUMENTS).size).toBe(REQUIRED_DOCUMENTS.length);
  });

  it("audits both themes", () => {
    expect([...THEMES]).toEqual<Theme[]>(["light", "dark"]);
  });

  it("keeps the theme-class exemption to the documents that cannot have one", () => {
    expect([...DOCUMENTS_WITHOUT_THEME_CLASS]).toEqual(["/_global-error"]);
  });
});
