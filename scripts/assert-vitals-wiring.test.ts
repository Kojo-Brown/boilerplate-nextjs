import { describe, expect, it } from "vitest";
import {
  REPORTER_COMPONENT,
  REPORTER_MODULE,
  ROOT_LAYOUT,
  checkEndpoint,
  checkReporter,
  checkRootLayout,
  collectSources,
  createRouteReader,
  main,
} from "./assert-vitals-wiring";
import type { RouteReader, SourceFile } from "./assert-vitals-wiring";

/**
 * The gate is exercised against synthetic sources, so each regression can be
 * written down as source text rather than staged on disk. The cases at the
 * bottom read the real repository — a gate that passes on hand-written fixtures
 * and fails on the tree it ships with would be worse than no gate.
 */
function file(relativePath: string, text: string): SourceFile {
  return { relativePath, text };
}

const WORKING_LAYOUT = file(
  ROOT_LAYOUT,
  `import { WebVitalsReporter } from "@/components/vitals/web-vitals-reporter";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <WebVitalsReporter />
      </body>
    </html>
  );
}
`,
);

const WORKING_REPORTER = file(
  REPORTER_MODULE,
  `"use client";

import { useEffect } from "react";
import { useReportWebVitals } from "next/web-vitals";

export function WebVitalsReporter(): null {
  useReportWebVitals((metric: unknown) => { queue.add(metric); });

  useEffect(() => {
    document.addEventListener("visibilitychange", flushIfHidden);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", flushIfHidden);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  return null;
}
`,
);

const WORKING_ROUTE = `import { defineRoute } from "@/lib/api/define-route";

export const POST = defineRoute({ handler: () => ({ accepted: 1 }) });
`;

function reader(text: string | null): RouteReader {
  return () => text;
}

describe("R1 — the root layout must render the reporter", () => {
  it("passes on the wiring as it ships", () => {
    expect(checkRootLayout([WORKING_LAYOUT])).toEqual([]);
  });

  it("catches the reporter being dropped from the layout", () => {
    // The regression this gate exists for: the application builds, renders and
    // serves every page correctly, and collects nothing.
    const findings = checkRootLayout([
      file(
        ROOT_LAYOUT,
        `export default function RootLayout({ children }) {
          return <html><body>{children}</body></html>;
        }`,
      ),
    ]);

    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.rule)).toEqual(["R1", "R1"]);
  });

  it("catches an import with no render — a component that is only referenced", () => {
    const findings = checkRootLayout([
      file(
        ROOT_LAYOUT,
        `import { WebVitalsReporter } from "@/components/vitals/web-vitals-reporter";
         export default function RootLayout({ children }) {
           return <html><body>{children}</body></html>;
         }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("does not render");
  });

  it("does not accept a type-only import as a render", () => {
    const findings = checkRootLayout([
      file(
        ROOT_LAYOUT,
        `import type { WebVitalsReporter } from "@/components/vitals/web-vitals-reporter";
         export default function RootLayout({ children }) {
           return <html><body>{children}</body></html>;
         }`,
      ),
    ]);

    expect(findings.map((f) => f.message)).toContain(
      `does not import <${REPORTER_COMPONENT}> as a value`,
    );
  });

  it("does not accept the component named in a comment or a string", () => {
    // A text search would pass on both of these.
    const findings = checkRootLayout([
      file(
        ROOT_LAYOUT,
        `import { WebVitalsReporter } from "@/components/vitals/web-vitals-reporter";
         // <WebVitalsReporter /> used to be here
         const note = "<WebVitalsReporter />";
         export default function RootLayout({ children }) {
           return <html><body>{children}{note}</body></html>;
         }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("does not render");
  });

  it("accepts the component rendered with children rather than self-closing", () => {
    const findings = checkRootLayout([
      file(
        ROOT_LAYOUT,
        `import { WebVitalsReporter } from "@/components/vitals/web-vitals-reporter";
         export default function RootLayout({ children }) {
           return <html><body><WebVitalsReporter>{children}</WebVitalsReporter></body></html>;
         }`,
      ),
    ]);

    expect(findings).toEqual([]);
  });

  it("reports a missing layout rather than passing on an empty file list", () => {
    const findings = checkRootLayout([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("missing entirely");
  });
});

describe("R2 — the reporter must subscribe", () => {
  it("passes on the reporter as it ships", () => {
    expect(checkReporter([WORKING_REPORTER])).toEqual([]);
  });

  it("catches a reporter that no longer calls the hook", () => {
    const findings = checkReporter([
      file(
        REPORTER_MODULE,
        `"use client";
         export function WebVitalsReporter(): null { return null; }`,
      ),
    ]);

    expect(findings.map((f) => f.rule)).toContain("R2");
    expect(findings.some((f) => f.message.includes("useReportWebVitals"))).toBe(
      true,
    );
  });

  it("catches the loss of the `use client` prologue", () => {
    const findings = checkReporter([
      file(
        REPORTER_MODULE,
        WORKING_REPORTER.text.replace(`"use client";\n`, ""),
      ),
    ]);

    expect(findings.some((f) => f.message.includes("use client"))).toBe(true);
  });

  it("reports a missing reporter module", () => {
    const findings = checkReporter([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("missing entirely");
  });
});

describe("R3 — the reporter must flush on the events that actually fire", () => {
  it("catches a missing visibilitychange listener", () => {
    const findings = checkReporter([
      file(
        REPORTER_MODULE,
        WORKING_REPORTER.text.replace(
          `document.addEventListener("visibilitychange", flushIfHidden);`,
          "",
        ),
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R3");
    expect(findings[0]?.message).toContain("visibilitychange");
  });

  it("catches a missing pagehide listener", () => {
    const findings = checkReporter([
      file(
        REPORTER_MODULE,
        WORKING_REPORTER.text.replace(
          `window.addEventListener("pagehide", flush);`,
          "",
        ),
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("pagehide");
  });

  it("catches a `beforeunload` listener, which costs the page its bfcache entry", () => {
    // The subtle one. Adding this looks like making the flush more reliable and
    // is the opposite: it is never dispatched on mobile Safari, and its mere
    // registration makes the visitor's next navigation slower — in the metric
    // this feature exists to measure.
    const findings = checkReporter([
      file(
        REPORTER_MODULE,
        WORKING_REPORTER.text.replace(
          `window.addEventListener("pagehide", flush);`,
          `window.addEventListener("pagehide", flush);
           window.addEventListener("beforeunload", flush);`,
        ),
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R3");
    expect(findings[0]?.message).toContain("back/forward cache");
  });

  it("catches an `unload` listener", () => {
    const findings = checkReporter([
      file(
        REPORTER_MODULE,
        WORKING_REPORTER.text.replace(
          `window.addEventListener("pagehide", flush);`,
          `window.addEventListener("unload", flush);`,
        ),
      ),
    ]);

    // Both the missing `pagehide` and the forbidden `unload`.
    expect(findings).toHaveLength(2);
  });

  it("does not accept a computed event name as satisfying a requirement", () => {
    // A name built at runtime is not something this gate can read, and
    // treating an unreadable call as satisfying the rule is how a check passes
    // on code it never understood.
    const findings = checkReporter([
      file(
        REPORTER_MODULE,
        WORKING_REPORTER.text.replace(
          `document.addEventListener("visibilitychange", flushIfHidden);`,
          "document.addEventListener(EVENT_NAME, flushIfHidden);",
        ),
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("visibilitychange");
  });
});

describe("R4/R5 — both ends must agree on a declared, budgeted endpoint", () => {
  it("passes against the repository's own declarations", () => {
    expect(checkEndpoint(reader(WORKING_ROUTE))).toEqual([]);
  });

  it("catches the route handler having been moved or renamed", () => {
    const findings = checkEndpoint(reader(null));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R4");
    expect(findings[0]?.message).toContain("no route handler exists");
  });

  it("catches a route handler that exports something other than POST", () => {
    const findings = checkEndpoint(
      reader(`export const GET = defineRoute({ handler: () => ({}) });`),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("does not export POST");
  });
});

describe("against the repository itself", () => {
  it("passes on the tree as it ships", () => {
    // The case that makes the rest of this file worth anything.
    expect(main(process.cwd())).toBe(0);
  });

  it("finds both sources it needs to read", () => {
    const files = collectSources(process.cwd());
    expect(files.map((f) => f.relativePath).sort()).toEqual(
      [REPORTER_MODULE, ROOT_LAYOUT].sort(),
    );
  });

  it("reads the real route handler off disk", () => {
    expect(createRouteReader(process.cwd())("/api/vitals")).toContain(
      "export const POST",
    );
  });

  it("returns null for a path with no handler", () => {
    expect(createRouteReader(process.cwd())("/api/not-a-route")).toBeNull();
  });
});
