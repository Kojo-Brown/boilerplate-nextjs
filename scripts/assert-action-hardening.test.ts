import { describe, it, expect } from "vitest";
import {
  checkExemptions,
  checkSources,
  collectSources,
  exportedValues,
  importedFactoryNames,
  main,
} from "./assert-action-hardening";
import ts from "typescript";

/**
 * The gate, exercised against synthetic modules rather than the repository, so
 * a rule can be shown to fire on the code it exists to reject — which is the
 * one thing running it over a passing tree cannot show.
 */

function source(text: string): ts.SourceFile {
  return ts.createSourceFile("x.ts", text, ts.ScriptTarget.ES2022, true);
}

const HEADER = `"use server";
import { defineAction } from "@/lib/actions/define-action";
import { defineAuthedAction } from "@/lib/actions/define-authed-action";
`;

function check(text: string, path = "src/actions/thing.ts") {
  return checkSources([{ relativePath: path, text }]);
}

describe("importedFactoryNames", () => {
  it("collects factories imported from the hardening modules", () => {
    expect([...importedFactoryNames(source(HEADER))].sort()).toEqual([
      "defineAction",
      "defineAuthedAction",
    ]);
  });

  it("records a renamed import under its local name", () => {
    const names = importedFactoryNames(
      source(
        `import { defineAction as harden } from "@/lib/actions/define-action";`,
      ),
    );
    expect([...names]).toEqual(["harden"]);
  });

  it("ignores an identically-named import from somewhere else", () => {
    const names = importedFactoryNames(
      source(`import { defineAction } from "@/lib/not-the-real-one";`),
    );
    expect([...names]).toEqual([]);
  });

  it("ignores a type-only import, which is not callable", () => {
    expect([
      ...importedFactoryNames(
        source(
          `import type { defineAction } from "@/lib/actions/define-action";`,
        ),
      ),
    ]).toEqual([]);
  });
});

describe("exportedValues", () => {
  it("skips types and interfaces, which are erased", () => {
    const values = exportedValues(
      source(
        `export type A = string; export interface B { x: 1 } export const c = f();`,
      ),
    );
    expect(values.map((v) => v.name)).toEqual(["c"]);
  });

  it("sees a non-exported const as not an endpoint", () => {
    expect(exportedValues(source(`const helper = () => 1;`))).toEqual([]);
  });
});

describe("A1 — every export is built by a factory", () => {
  it("passes an action built by defineAuthedAction", () => {
    expect(
      check(`${HEADER}
export const doThing = defineAuthedAction({ name: "doThing", input: s, handler: h });
`),
    ).toEqual([]);
  });

  it("fails a bare `export async function`", () => {
    // The form every action in this repository used to have, and the form that
    // lets an author forget a leg without anything looking wrong.
    const findings = check(`${HEADER}
export async function doThing(id: string) { return id; }
`);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("A1");
    expect(findings[0]?.message).toMatch(/`export function` declaration/);
  });

  it("fails an exported arrow function", () => {
    const findings = check(`${HEADER}
export const doThing = async (id: string) => id;
`);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/a bare function/);
  });

  it("fails an export built by some other call", () => {
    const findings = check(`${HEADER}
export const doThing = wrapSomehow({ handler: h });
`);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("A1");
    expect(findings[0]?.message).toMatch(/not a hardening factory/);
  });

  it("fails an exported constant, which is still a POST endpoint", () => {
    // Next makes every export reachable, including one that was never meant to
    // be called — `src/actions/blog.ts` has the post-mortem.
    const findings = check(`${HEADER}
export const TARGETS = { "/blog": 1 };
`);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("A1");
  });

  it("reports each bad export separately", () => {
    const findings = check(`${HEADER}
export const a = wrapSomehow({});
export const b = async () => 1;
`);

    expect(findings.map((f) => f.message)).toHaveLength(2);
  });

  it("ignores modules outside src/actions/", () => {
    expect(
      check(`export async function helper() {}`, "src/lib/dal/posts.ts"),
    ).toEqual([]);
  });

  it("ignores a module in src/actions/ without the directive", () => {
    // No `"use server"` means no endpoints — it is a plain module the actions
    // import, which is exactly where `invalidate()` was moved to.
    expect(
      check(`export const helper = () => 1;`, "src/actions/helpers.ts"),
    ).toEqual([]);
  });
});

describe("A2 — the factory name must come from the hardening modules", () => {
  it("fails a locally-defined function with the right name", () => {
    // The cheapest possible way to make A1 green and mean nothing.
    const findings = checkSources([
      {
        relativePath: "src/actions/thing.ts",
        text: `"use server";
function defineAction(spec) { return spec.handler; }
export const doThing = defineAction({ handler: h });
`,
      },
    ]);

    // The local helper is not itself exported, so it is not an endpoint; the
    // action built with it is what gets flagged.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("A2");
    expect(findings[0]?.message).toMatch(/does not import/);
  });

  it("accepts a renamed import", () => {
    expect(
      checkSources([
        {
          relativePath: "src/actions/thing.ts",
          text: `"use server";
import { defineAction as harden } from "@/lib/actions/define-action";
export const doThing = harden({ name: "x", input: s, handler: h });
`,
        },
      ]),
    ).toEqual([]);
  });
});

describe("checkExemptions", () => {
  it("has nothing to say while EXEMPT is empty", () => {
    expect(checkExemptions([])).toEqual([]);
  });
});

describe("the repository itself", () => {
  it("passes", () => {
    // The gate is only worth having if it is green on the tree it ships with.
    const findings = [
      ...checkSources(collectSources(process.cwd())),
      ...checkExemptions(collectSources(process.cwd())),
    ];
    expect(findings).toEqual([]);
  });

  it("finds Server Action modules to check", () => {
    // A collector that silently matched nothing would pass every rule.
    expect(collectSources(process.cwd()).length).toBeGreaterThan(0);
    expect(main(process.cwd())).toBe(0);
  });
});
