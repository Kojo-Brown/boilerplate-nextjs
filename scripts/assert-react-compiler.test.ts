import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_FILE,
  KEEP_TAG,
  MIN_REASON_LENGTH,
  OPT_OUT_DIRECTIVE,
  PACKAGE_FILE,
  REQUIRED_PACKAGES,
  SERVER_FILES_MANIFEST,
  checkBuildManifest,
  checkCompilation,
  checkConfig,
  checkManualMemos,
  checkOptOuts,
  checkPackages,
  collectClientGraph,
  collectSources,
  compileAll,
  createCompiler,
  extractReason,
  findManualMemos,
  findReason,
  isClientEntry,
  main,
  resolveSpecifier,
} from "./assert-react-compiler";
import type { CompileEvent, SourceFile } from "./assert-react-compiler";

/**
 * The rules are exercised against synthetic sources, so each regression can be
 * written down as source text rather than staged on disk. The cases at the
 * bottom read the real repository and drive the real compiler — a gate that
 * passes on hand-written fixtures and fails on the tree it ships with would be
 * worse than no gate.
 */
function file(relativePath: string, text: string): SourceFile {
  return { relativePath, text };
}

const ENABLED_CONFIG = file(
  CONFIG_FILE,
  `import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  reactCompiler: true,
};

export default config;
`,
);

describe("R1 — the config source", () => {
  it("passes when the compiler is enabled", () => {
    expect(checkConfig([ENABLED_CONFIG])).toEqual([]);
  });

  it("fails when the option is absent", () => {
    const withoutIt = file(
      CONFIG_FILE,
      `const config = { output: "standalone" };\nexport default config;\n`,
    );

    expect(checkConfig([withoutIt])).toMatchObject([{ rule: "R1" }]);
  });

  it("fails when the option is explicitly false", () => {
    const off = file(CONFIG_FILE, `export default { reactCompiler: false };\n`);

    expect(checkConfig([off])).toMatchObject([{ rule: "R1" }]);
  });

  it("fails on annotation mode rather than accepting it silently", () => {
    // A valid value for the option and a different feature: every new
    // component would ship unmemoized until someone remembered `"use memo"`.
    const annotation = file(
      CONFIG_FILE,
      `export default { reactCompiler: { compilationMode: "annotation" } };\n`,
    );

    expect(checkConfig([annotation])).toMatchObject([{ rule: "R1" }]);
  });

  it("fails when there is no config at all", () => {
    expect(checkConfig([])).toMatchObject([{ rule: "R1" }]);
  });
});

describe("R2 — what the build resolved", () => {
  it("passes when the manifest records the compiler as on", () => {
    expect(checkBuildManifest({ config: { reactCompiler: true } })).toEqual([]);
  });

  it("fails when the build resolved it to false", () => {
    expect(
      checkBuildManifest({ config: { reactCompiler: false } }),
    ).toMatchObject([{ rule: "R2", file: SERVER_FILES_MANIFEST }]);
  });

  it("fails when there is no build output to read", () => {
    expect(checkBuildManifest(null)).toMatchObject([{ rule: "R2" }]);
  });

  it("fails when the option is missing from the resolved config", () => {
    // A rename upstream looks exactly like this: the source still says
    // `reactCompiler: true` and the build has never heard of it.
    expect(checkBuildManifest({ config: {} })).toMatchObject([{ rule: "R2" }]);
  });
});

describe("R3 — the packages", () => {
  it("passes when both are declared", () => {
    const manifest = {
      devDependencies: Object.fromEntries(
        REQUIRED_PACKAGES.map((name) => [name, "1.0.0"]),
      ),
    };

    expect(checkPackages(manifest)).toEqual([]);
  });

  it("accepts a package declared as a runtime dependency", () => {
    const manifest = {
      dependencies: { "@babel/core": "7.29.7" },
      devDependencies: { "babel-plugin-react-compiler": "1.0.0" },
    };

    expect(checkPackages(manifest)).toEqual([]);
  });

  it("names each missing package", () => {
    expect(checkPackages({})).toMatchObject([
      { rule: "R3", file: PACKAGE_FILE },
      { rule: "R3", file: PACKAGE_FILE },
    ]);
  });
});

describe("R4 — the compiler's verdict", () => {
  const compiled: CompileEvent = {
    file: "src/components/ui/dialog.tsx",
    name: "Dialog",
    compiled: true,
  };

  it("passes when everything compiled", () => {
    expect(checkCompilation([compiled])).toEqual([]);
  });

  it("fails on a bail-out and quotes the compiler's reason", () => {
    const bailed: CompileEvent = {
      file: "src/components/ui/image-upload.tsx",
      name: "ImageUpload",
      compiled: false,
      reason: "Support value blocks within a try/catch statement",
    };

    const findings = checkCompilation([compiled, bailed]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "R4",
      file: "src/components/ui/image-upload.tsx",
    });
    expect(findings[0]?.message).toContain("ImageUpload");
    expect(findings[0]?.message).toContain("try/catch");
  });

  it("still reports a bail-out the compiler gave no reason for", () => {
    const findings = checkCompilation([
      { file: "src/a.tsx", name: "A", compiled: false },
    ]);

    expect(findings[0]?.message).toContain("no reason given");
  });
});

describe("R5 — memoization that survived", () => {
  it("fails on an unjustified useCallback", () => {
    const source = file(
      "src/components/x.tsx",
      `"use client";
import { useCallback } from "react";

export function X({ onPick }: { onPick: () => void }) {
  const handle = useCallback(() => onPick(), [onPick]);
  return <button onClick={handle} />;
}
`,
    );

    expect(checkManualMemos([source])).toMatchObject([{ rule: "R5" }]);
  });

  it("fails on an unjustified useMemo", () => {
    const source = file(
      "src/components/x.tsx",
      `"use client";
import { useMemo } from "react";

export function X({ rows }: { rows: number[] }) {
  const total = useMemo(() => rows.length, [rows]);
  return <p>{total}</p>;
}
`,
    );

    expect(checkManualMemos([source])).toMatchObject([{ rule: "R5" }]);
  });

  it("fails on an unjustified memo() wrapper", () => {
    const source = file(
      "src/components/x.tsx",
      `"use client";
import { memo } from "react";

export const X = memo(function X() {
  return <p>x</p>;
});
`,
    );

    expect(checkManualMemos([source])).toMatchObject([{ rule: "R5" }]);
  });

  it("passes a memo carrying a real reason", () => {
    const source = file(
      "src/components/x.tsx",
      `"use client";
import { useCallback } from "react";

export function X({ onPick }: { onPick: () => void }) {
  /**
   * ${KEEP_TAG} The subscriber adds a listener per identity and returns no
   * teardown, so a fresh function would subscribe twice.
   */
  const handle = useCallback(() => onPick(), [onPick]);
  return <button onClick={handle} />;
}
`,
    );

    expect(checkManualMemos([source])).toEqual([]);
  });

  it("accepts the tag on a run of line comments", () => {
    const source = file(
      "src/components/x.tsx",
      `"use client";
import { useCallback } from "react";

export function X({ onPick }: { onPick: () => void }) {
  // ${KEEP_TAG} The subscriber adds a listener per identity and returns no
  // teardown, so a fresh function would subscribe twice.
  const handle = useCallback(() => onPick(), [onPick]);
  return <button onClick={handle} />;
}
`,
    );

    expect(checkManualMemos([source])).toEqual([]);
  });

  it("fails a tag with nothing behind it", () => {
    const source = file(
      "src/components/x.tsx",
      `"use client";
import { useCallback } from "react";

export function X({ onPick }: { onPick: () => void }) {
  /** ${KEEP_TAG} needed */
  const handle = useCallback(() => onPick(), [onPick]);
  return <button onClick={handle} />;
}
`,
    );

    expect(checkManualMemos([source])).toMatchObject([{ rule: "R5" }]);
  });

  it("does not let the comment above a memo lend it a reason", () => {
    // The regression that made this rule worth testing: a
    // `VariableDeclarationList` and the `VariableStatement` around it start at
    // the same offset, so every comment was collected twice. Joined, the
    // duplicate put prose *after* the tag and a one-word reason cleared the
    // length check on borrowed words.
    const source = file(
      "src/components/x.tsx",
      `"use client";
import { useCallback } from "react";

export function X({ onPick }: { onPick: () => void }) {
  // A long explanatory comment that has nothing at all to do with the tag.
  /** ${KEEP_TAG} needed */
  const handle = useCallback(() => onPick(), [onPick]);
  return <button onClick={handle} />;
}
`,
    );

    expect(checkManualMemos([source])).toMatchObject([{ rule: "R5" }]);
  });

  it("ignores a call that merely shares the name", () => {
    const source = file(
      "src/lib/x.ts",
      `import { memo } from "./cache";

export const value = memo;
export function useMemoized() {
  return 1;
}
`,
    );

    expect(checkManualMemos([source])).toEqual([]);
  });
});

describe("R6 — opt-outs", () => {
  it("fails on an undocumented directive", () => {
    const source = file(
      "src/components/x.tsx",
      `"use client";

export function X() {
  "${OPT_OUT_DIRECTIVE}";
  return <p>x</p>;
}
`,
    );

    expect(checkOptOuts([source])).toMatchObject([{ rule: "R6" }]);
  });

  it("passes a directive with a reason attached", () => {
    const source = file(
      "src/components/x.tsx",
      `"use client";

export function X() {
  /** ${KEEP_TAG} Compiling this trips a known upstream bug, see #1234. */
  "${OPT_OUT_DIRECTIVE}";
  return <p>x</p>;
}
`,
    );

    expect(checkOptOuts([source])).toEqual([]);
  });

  it("ignores the string in a position that is not a directive", () => {
    const source = file(
      "src/components/x.tsx",
      `"use client";

export function X() {
  return <p>{"${OPT_OUT_DIRECTIVE}"}</p>;
}
`,
    );

    expect(checkOptOuts([source])).toEqual([]);
  });
});

describe("reading the tag", () => {
  it("returns null when the tag is absent", () => {
    expect(extractReason("/** nothing to see */")).toBeNull();
    expect(findReason(["// one", "// two"])).toBeNull();
  });

  it("strips doc-block punctuation from the reason", () => {
    const reason = extractReason(
      `/**\n * ${KEEP_TAG} Because the subscriber never unsubscribes.\n */`,
    );

    expect(reason).toBe("Because the subscriber never unsubscribes.");
  });

  it("takes the first tagged comment when several are attached", () => {
    expect(
      findReason([
        "// untagged",
        `// ${KEEP_TAG} first`,
        `// ${KEEP_TAG} second`,
      ]),
    ).toBe("first");
  });

  it("agrees with the threshold the rule enforces", () => {
    expect("Because the subscriber never unsubscribes.".length).toBeGreaterThan(
      MIN_REASON_LENGTH,
    );
  });
});

describe("the client graph", () => {
  it("recognises a client entry through leading comments", () => {
    expect(
      isClientEntry(
        file("src/a.tsx", `"use client";\n\nexport const a = 1;\n`),
      ),
    ).toBe(true);
    expect(isClientEntry(file("src/b.tsx", `export const b = 1;\n`))).toBe(
      false,
    );
  });

  it("does not mistake a string in the body for the directive", () => {
    expect(
      isClientEntry(
        file(
          "src/c.tsx",
          `export const mode = "use client";\nexport const c = 1;\n`,
        ),
      ),
    ).toBe(false);
  });

  it("resolves @/ and relative specifiers, and skips packages", () => {
    const known = new Set([
      "src/lib/cn.ts",
      "src/components/ui/button.tsx",
      "src/hooks/index.ts",
    ]);

    expect(resolveSpecifier("src/components/x.tsx", "@/lib/cn", known)).toBe(
      "src/lib/cn.ts",
    );
    expect(resolveSpecifier("src/components/x.tsx", "./ui/button", known)).toBe(
      "src/components/ui/button.tsx",
    );
    expect(resolveSpecifier("src/components/x.tsx", "@/hooks", known)).toBe(
      "src/hooks/index.ts",
    );
    expect(resolveSpecifier("src/components/x.tsx", "react", known)).toBeNull();
    expect(
      resolveSpecifier("src/components/x.tsx", "@/lib/gone", known),
    ).toBeNull();
  });

  it("reaches modules a client entry imports, and stops at server-only ones", () => {
    const files = [
      file(
        "src/components/x.tsx",
        `"use client";\nimport { cn } from "@/lib/cn";\nimport { Inner } from "./inner";\nexport const X = () => <Inner className={cn("a")} />;\n`,
      ),
      file("src/components/inner.tsx", `export const Inner = () => null;\n`),
      file("src/lib/cn.ts", `export const cn = (s: string) => s;\n`),
      file(
        "src/app/page.tsx",
        `export default function Page() { return null; }\n`,
      ),
    ];

    expect(collectClientGraph(files).map((f) => f.relativePath)).toEqual([
      "src/components/inner.tsx",
      "src/components/x.tsx",
      "src/lib/cn.ts",
    ]);
  });

  it("terminates on an import cycle", () => {
    const files = [
      file("src/a.tsx", `"use client";\nimport "./b";\nexport const a = 1;\n`),
      file("src/b.tsx", `import "./a";\nexport const b = 1;\n`),
    ];

    expect(collectClientGraph(files)).toHaveLength(2);
  });

  it("follows a re-export as well as an import", () => {
    const files = [
      file("src/a.tsx", `"use client";\nexport * from "./b";\n`),
      file("src/b.tsx", `export const b = 1;\n`),
    ];

    expect(collectClientGraph(files)).toHaveLength(2);
  });
});

describe("against the repository itself", () => {
  const root = process.cwd();

  it("finds a client graph that is a real subset of src/", () => {
    const sources = collectSources(root);
    const graph = collectClientGraph(sources);

    expect(graph.length).toBeGreaterThan(0);
    expect(graph.length).toBeLessThan(sources.length);
    expect(graph.map((f) => f.relativePath)).toContain(
      "src/components/ui/dialog.tsx",
    );
  });

  it("has the compiler enabled and both packages declared", () => {
    const config = {
      relativePath: CONFIG_FILE,
      text: readFileSync(path.join(root, CONFIG_FILE), "utf8"),
    };
    const manifest = JSON.parse(
      readFileSync(path.join(root, PACKAGE_FILE), "utf8"),
    ) as Parameters<typeof checkPackages>[0];

    expect(checkConfig([config])).toEqual([]);
    expect(checkPackages(manifest)).toEqual([]);
  });

  it("leaves exactly one manual memo, and it is justified", () => {
    // The audit's actual result. Three `useCallback`s were removed when the
    // compiler was enabled; the one that stayed is load-bearing for
    // correctness rather than for performance, which is why the count is
    // pinned here rather than left to the rule alone.
    const sources = collectSources(root);
    const memos = findManualMemos(sources);

    expect(memos).toHaveLength(1);
    expect(memos[0]).toMatchObject({
      file: "src/components/vitals/web-vitals-reporter.tsx",
      name: "useCallback",
    });
    expect(memos[0]?.reason ?? "").not.toHaveLength(0);
    expect(checkManualMemos(sources)).toEqual([]);
    expect(checkOptOuts(sources)).toEqual([]);
  });

  it("compiles every client-graph module with the real compiler", () => {
    const graph = collectClientGraph(collectSources(root));
    const events = compileAll(graph, createCompiler(root));

    expect(checkCompilation(events)).toEqual([]);
    // If this ever reaches zero the gate has stopped looking at anything.
    expect(events.filter((event) => event.compiled).length).toBeGreaterThan(20);
  }, 180_000);

  it("reports a bail-out through main, whatever else is green", () => {
    // Driven with a fake compiler so the exit code is the rule's answer and
    // not a statement about whether `pnpm build` has run in this working
    // tree. The green end-to-end run is the CI step itself.
    const bailed = () => [
      { file: "src/components/ui/dialog.tsx", name: "Dialog", compiled: false },
    ];

    expect(main(root, bailed)).toBe(1);
  });
});
