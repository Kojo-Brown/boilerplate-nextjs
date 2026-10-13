import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  ALLOWANCES,
  LANDMARK_MODULE,
  RAW_MAIN_ALLOWED,
  REQUIRED_DOCUMENTS,
  ROOT_LAYOUT,
  ROUTE_FOCUS_MODULE,
  bodyOf,
  checkAllowances,
  checkDocument,
  checkNoRawMain,
  checkRequiredDocuments,
  checkRootLayout,
  checkRouteFocusModule,
  collectSources,
  firstFocusableTag,
  type PrerenderedDocument,
  type SourceFile,
} from "./assert-focus-management";
import { MAIN_CONTENT_ID, SKIP_LINK_HREF } from "../src/lib/a11y/route-focus";

const ROOT = process.cwd();

function source(relativePath: string, text: string): SourceFile {
  return { relativePath, text };
}

/** A document body with the skip link and a well-formed landmark. */
function goodDocument(overrides: Partial<PrerenderedDocument> = {}) {
  return {
    document: "/dashboard",
    html:
      "<html><body>" +
      `<a href="${SKIP_LINK_HREF}">Skip to main content</a>` +
      '<header><a href="/">Home</a></header>' +
      `<main id="${MAIN_CONTENT_ID}" tabindex="-1"><h1>Dashboard</h1></main>` +
      "</body></html>",
    ...overrides,
  } satisfies PrerenderedDocument;
}

describe("the gate over this repository", () => {
  const sources = collectSources(ROOT);

  it("passes R1 on the real root layout", () => {
    expect(checkRootLayout(sources)).toEqual([]);
  });

  it("passes R2 over the whole of src", () => {
    expect(checkNoRawMain(sources)).toEqual([]);
  });

  it("passes R3 on the real focus manager", () => {
    expect(checkRouteFocusModule(sources)).toEqual([]);
  });

  it("collects the modules the other rules are about", () => {
    const paths = sources.map((file) => file.relativePath);
    expect(paths).toContain(ROOT_LAYOUT);
    expect(paths).toContain(ROUTE_FOCUS_MODULE);
    expect(paths).toContain(LANDMARK_MODULE);
  });

  it("does not collect test files", () => {
    // A `.test.tsx` that renders a raw <main> as a fixture is not a route,
    // and R2 failing on one would be a gate nobody could satisfy.
    expect(
      sources.filter((file) => file.relativePath.includes(".test.")),
    ).toEqual([]);
  });
});

describe("R1 — the root layout", () => {
  const withBoth = source(
    ROOT_LAYOUT,
    `export default function Layout() {
       return <body><SkipLink /><RouteFocus /></body>;
     }`,
  );

  it("accepts a layout with both components", () => {
    expect(checkRootLayout([withBoth])).toEqual([]);
  });

  it("fails when the layout is missing entirely", () => {
    expect(checkRootLayout([])).toEqual([
      { file: ROOT_LAYOUT, rule: "R1", message: "the root layout is missing" },
    ]);
  });

  it("fails when the skip link is gone", () => {
    const findings = checkRootLayout([
      source(
        ROOT_LAYOUT,
        `export default function Layout() {
           return <body><RouteFocus /></body>;
         }`,
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("<SkipLink>");
  });

  it("fails when the focus manager is gone", () => {
    const findings = checkRootLayout([
      source(
        ROOT_LAYOUT,
        `export default function Layout() {
        return <body><SkipLink /></body>;
      }`,
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("<RouteFocus>");
  });
});

describe("R2 — raw <main>", () => {
  it("fails on a route that writes its own landmark", () => {
    const findings = checkNoRawMain([
      source(
        "src/app/reports/layout.tsx",
        `export default function L() {
        return <main className="p-4">x</main>;
      }`,
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R2");
    expect(findings[0]?.file).toBe("src/app/reports/layout.tsx");
  });

  it("allows the landmark component itself", () => {
    expect(
      checkNoRawMain([
        source(
          LANDMARK_MODULE,
          `export function MainContent() {
          return <main id="main-content" tabIndex={-1} />;
        }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("allows global-error, which replaces the root layout", () => {
    expect(RAW_MAIN_ALLOWED).toContain("src/app/global-error.tsx");
    expect(
      checkNoRawMain([
        source(
          "src/app/global-error.tsx",
          `export default function E() {
          return <main>failed</main>;
        }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("ignores a component whose name merely starts with main", () => {
    expect(
      checkNoRawMain([
        source(
          "src/app/x/page.tsx",
          `export default function P() {
          return <MainContent>x</MainContent>;
        }`,
        ),
      ]),
    ).toEqual([]);
  });
});

describe("R3 — the focus manager", () => {
  const good = source(
    ROUTE_FOCUS_MODULE,
    `"use client";
     import { usePathname } from "next/navigation";
     function RouteFocusEffects() {
       const pathname = usePathname();
       element.focus({ preventScroll: true });
       return null;
     }
     export function RouteFocus() {
       return useIsHydrated() ? <RouteFocusEffects /> : null;
     }`,
  );

  it("accepts the shape the feature needs", () => {
    expect(checkRouteFocusModule([good])).toEqual([]);
  });

  it("fails when the module is missing", () => {
    expect(checkRouteFocusModule([])).toEqual([
      {
        file: ROUTE_FOCUS_MODULE,
        rule: "R3",
        message: "the focus manager is missing",
      },
    ]);
  });

  it("fails when the client prologue is gone", () => {
    const findings = checkRouteFocusModule([
      source(ROUTE_FOCUS_MODULE, good.text.replace('"use client";', "")),
    ]);
    expect(findings.map((finding) => finding.message)).toContain(
      `is not a "use client" module, so none of it runs`,
    );
  });

  it("fails when it stops reading the route", () => {
    const findings = checkRouteFocusModule([
      source(
        ROUTE_FOCUS_MODULE,
        good.text.replace(/usePathname/g, "useNothing"),
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("usePathname()");
  });

  it("fails when the router read is not gated on hydration", () => {
    // `usePathname()` suspends while prerendering a fallback shell for a
    // dynamic segment, and at the root of the tree that empties four shells.
    // A <Suspense> boundary is not the fix — it trades those for a pending
    // boundary with an empty fallback, which the streaming gate fails on.
    const findings = checkRouteFocusModule([
      source(
        ROUTE_FOCUS_MODULE,
        good.text.replace(
          /useIsHydrated\(\) \? <RouteFocusEffects \/> : null/,
          "null",
        ),
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("useIsHydrated()");
  });

  it("fails when it focuses without preventScroll", () => {
    const findings = checkRouteFocusModule([
      source(
        ROUTE_FOCUS_MODULE,
        good.text.replace("{ preventScroll: true }", ""),
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("preventScroll");
  });
});

describe("R4 and R5 — the prerendered documents", () => {
  it("accepts a well-formed document", () => {
    expect(checkDocument(goodDocument())).toEqual([]);
  });

  it("fails a document with no landmark", () => {
    const findings = checkDocument(
      goodDocument({
        html: `<html><body><a href="${SKIP_LINK_HREF}">Skip</a></body></html>`,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R4");
    expect(findings[0]?.message).toContain("points at a fragment");
  });

  it("fails a document with two landmarks", () => {
    const findings = checkDocument(
      goodDocument({
        html:
          "<html><body>" +
          `<a href="${SKIP_LINK_HREF}">Skip</a>` +
          `<main id="${MAIN_CONTENT_ID}" tabindex="-1">a</main>` +
          `<div id="${MAIN_CONTENT_ID}" tabindex="-1">b</div>` +
          "</body></html>",
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("2 elements");
  });

  it("fails a landmark that cannot be focused", () => {
    // The whole point. A <main> without tabindex looks correct, scrolls into
    // view when the skip link is followed, and leaves focus in the header.
    const findings = checkDocument(
      goodDocument({
        html:
          "<html><body>" +
          `<a href="${SKIP_LINK_HREF}">Skip</a>` +
          `<main id="${MAIN_CONTENT_ID}">a</main>` +
          "</body></html>",
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('tabindex="-1"');
  });

  it("fails a landmark id on something that is not a <main>", () => {
    const findings = checkDocument(
      goodDocument({
        html:
          "<html><body>" +
          `<a href="${SKIP_LINK_HREF}">Skip</a>` +
          `<div id="${MAIN_CONTENT_ID}" tabindex="-1">a</div>` +
          "</body></html>",
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("not a <main> landmark");
  });

  it("fails a document with no skip link", () => {
    const findings = checkDocument(
      goodDocument({
        html: `<html><body><main id="${MAIN_CONTENT_ID}" tabindex="-1">a</main></body></html>`,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R5");
  });

  it("fails a skip link that is not first", () => {
    const findings = checkDocument(
      goodDocument({
        html:
          "<html><body>" +
          '<nav><a href="/dashboard">Dashboard</a></nav>' +
          `<a href="${SKIP_LINK_HREF}">Skip</a>` +
          `<main id="${MAIN_CONTENT_ID}" tabindex="-1">a</main>` +
          "</body></html>",
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R5");
    expect(findings[0]?.message).toContain("<a> before the skip link");
  });

  it("fails a button ahead of the skip link too", () => {
    const findings = checkDocument(
      goodDocument({
        html:
          "<html><body>" +
          '<button type="button">Open menu</button>' +
          `<a href="${SKIP_LINK_HREF}">Skip</a>` +
          `<main id="${MAIN_CONTENT_ID}" tabindex="-1">a</main>` +
          "</body></html>",
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("<button> before the skip link");
  });

  it("ignores focusable elements in <head>", () => {
    // Nothing in <head> is focusable, and a <link> or a <script src> there
    // would otherwise be read as markup ahead of the skip link.
    expect(
      checkDocument(
        goodDocument({
          html:
            '<html><head><link rel="stylesheet" href="/a.css" /></head><body>' +
            `<a href="${SKIP_LINK_HREF}">Skip</a>` +
            `<main id="${MAIN_CONTENT_ID}" tabindex="-1">a</main>` +
            "</body></html>",
        }),
      ),
    ).toEqual([]);
  });

  it("tolerates the hidden streaming div React emits before the skip link", () => {
    expect(
      checkDocument(
        goodDocument({
          html:
            '<html><body><div hidden=""><!--$--><!--/$--></div>' +
            `<a href="${SKIP_LINK_HREF}" data-skip-link-target="${MAIN_CONTENT_ID}">Skip</a>` +
            `<main id="${MAIN_CONTENT_ID}" tabindex="-1">a</main>` +
            "</body></html>",
        }),
      ),
    ).toEqual([]);
  });
});

describe("R6 — required documents", () => {
  it("passes when every required document was built", () => {
    const documents = REQUIRED_DOCUMENTS.map((document) => ({
      document,
      html: "",
    }));
    expect(checkRequiredDocuments(documents)).toEqual([]);
  });

  it("fails when a route stops prerendering", () => {
    const documents = REQUIRED_DOCUMENTS.filter(
      (document) => document !== "/_not-found",
    ).map((document) => ({ document, html: "" }));

    const findings = checkRequiredDocuments(documents);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("/_not-found");
  });
});

describe("allowances", () => {
  it("every allowance matches a document the build actually writes", () => {
    const documents = ALLOWANCES.map((allowance) => ({
      document: allowance.document,
      html: "",
    }));
    expect(checkAllowances(documents)).toEqual([]);
  });

  it("fails on an exemption that stopped matching anything", () => {
    const findings = checkAllowances([{ document: "/index", html: "" }]);
    expect(findings).toHaveLength(ALLOWANCES.length);
    expect(findings[0]?.rule).toBe("A1");
    expect(findings[0]?.message).toContain("remove it");
  });

  it("gives a reason for each exemption", () => {
    for (const allowance of ALLOWANCES) {
      expect(allowance.because.length).toBeGreaterThan(20);
    }
  });
});

describe("helpers", () => {
  it("finds the first focusable tag", () => {
    expect(firstFocusableTag("<div><span>x</span><button>y</button>")).toBe(
      "button",
    );
    expect(firstFocusableTag("<div>x</div>")).toBeNull();
  });

  it("does not mistake an attribute for a tag", () => {
    // `<article data-a="1">` must not read as an <a>.
    expect(firstFocusableTag('<article data-a="1">x</article>')).toBeNull();
  });

  it("slices the body out of a document", () => {
    expect(bodyOf("<html><head>h</head><body>b</body></html>")).toContain("b");
    expect(bodyOf("<html><head>h</head><body>b</body></html>")).not.toContain(
      "head",
    );
  });

  it("returns the whole string for a fragment with no body", () => {
    expect(bodyOf("<main>x</main>")).toBe("<main>x</main>");
  });

  it("reads the resolved landmark constants rather than copies", () => {
    // The gate and the components must agree about the id; importing it is
    // what makes a rename a type error instead of a silently inert gate.
    expect(SKIP_LINK_HREF).toBe(`#${MAIN_CONTENT_ID}`);
  });
});
