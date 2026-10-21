import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  ALLOWED,
  RULES,
  baseToken,
  checkSource,
  extractStringLiterals,
  formatViolations,
  physicalViolation,
  sourceFiles,
} from "./assert-logical-properties";

describe("extractStringLiterals", () => {
  it("returns the contents of each quoted form", () => {
    expect(
      extractStringLiterals(
        `const a = "one"; const b = 'two'; const c = \`three\`;`,
      ),
    ).toEqual([
      { text: "one", line: 1 },
      { text: "two", line: 1 },
      { text: "three", line: 1 },
    ]);
  });

  it("skips line comments", () => {
    // This is the false positive the gate exists in this shape to avoid:
    // documenting `ml-4` must not be the same as writing it.
    expect(extractStringLiterals(`// className="ml-4"\nconst a = 1;`)).toEqual(
      [],
    );
  });

  it("skips block comments, including the ones spanning lines", () => {
    expect(
      extractStringLiterals(`/*\n * "ml-4" and "text-left"\n */\nconst a = 1;`),
    ).toEqual([]);
  });

  it("does not treat a comment marker inside a literal as a comment", () => {
    expect(extractStringLiterals(`const a = "https://example.test";`)).toEqual([
      { text: "https://example.test", line: 1 },
    ]);
  });

  it("does not let an escaped quote close a literal", () => {
    expect(extractStringLiterals(`const a = "say \\"ml-4\\" aloud";`)).toEqual([
      { text: 'say "ml-4" aloud', line: 1 },
    ]);
  });

  it("emits an escaped newline as whitespace, so it still separates tokens", () => {
    // Dropping the escape would produce the single token `ml-4mr-2`, which
    // matches no rule — two violations would become none.
    expect(
      checkSource("a.tsx", `const a = "ml-4\\nmr-2";`).map((v) => v.token),
    ).toEqual(["ml-4", "mr-2"]);
  });

  it("reports the line the literal starts on", () => {
    expect(extractStringLiterals(`const a = 1;\n\nconst b = "ml-4";`)).toEqual([
      { text: "ml-4", line: 3 },
    ]);
  });

  it("returns a template literal's interpolations as text", () => {
    // Documented behaviour rather than an accident: an identifier is never a
    // banned token, so including it costs nothing.
    expect(extractStringLiterals("const a = `a ${b} c`;")).toEqual([
      { text: "a ${b} c", line: 1 },
    ]);
  });
});

describe("baseToken", () => {
  it("is the token itself when there is nothing to strip", () => {
    expect(baseToken("ml-4")).toBe("ml-4");
  });

  it("strips a single variant", () => {
    expect(baseToken("sm:ml-4")).toBe("ml-4");
  });

  it("strips stacked variants", () => {
    expect(baseToken("lg:focus-visible:ml-4")).toBe("ml-4");
  });

  it("strips a negative sign that follows the variants", () => {
    expect(baseToken("sm:-ml-4")).toBe("ml-4");
  });
});

describe("physicalViolation", () => {
  it("names the logical margin and padding utilities", () => {
    expect(physicalViolation("ml-4")).toBe("ms-4");
    expect(physicalViolation("mr-2")).toBe("me-2");
    expect(physicalViolation("pl-8")).toBe("ps-8");
    expect(physicalViolation("pr-0.5")).toBe("pe-0.5");
  });

  it("handles inset, border, rounding, alignment and float", () => {
    expect(physicalViolation("left-0")).toBe("start-0");
    expect(physicalViolation("right-4")).toBe("end-4");
    expect(physicalViolation("border-r")).toBe("border-e");
    expect(physicalViolation("border-l-2")).toBe("border-s-2");
    expect(physicalViolation("rounded-tr-lg")).toBe("rounded-se-lg");
    expect(physicalViolation("text-left")).toBe("text-start");
    expect(physicalViolation("float-right")).toBe("float-end");
  });

  it("keeps the variant chain and the sign in its suggestion", () => {
    expect(physicalViolation("sm:-mr-2")).toBe("sm:-me-2");
    expect(physicalViolation("lg:hover:pl-4")).toBe("lg:hover:ps-4");
  });

  it("carries the note for the families that need restructuring", () => {
    expect(physicalViolation("space-x-4")).toBe(
      "gap-x-4 on a flex or grid parent",
    );
    expect(physicalViolation("divide-x")).toBe("border-s on each child");
  });

  it("accepts arbitrary and variable values", () => {
    expect(physicalViolation("ml-[3px]")).toBe("ms-[3px]");
    expect(physicalViolation("ml-(--gutter)")).toBe("ms-(--gutter)");
  });

  it("allows the centring idioms", () => {
    // `start-1/2` with `-translate-x-1/2` moves a centred dialog off-screen
    // under RTL; the physical spelling is the correct one here.
    expect(physicalViolation("left-1/2")).toBeUndefined();
    expect(physicalViolation("right-1/2")).toBeUndefined();
    expect(physicalViolation("-left-1/2")).toBeUndefined();
  });

  it("leaves logical and symmetric utilities alone", () => {
    for (const token of [
      "ms-4",
      "me-2",
      "ps-8",
      "pe-1",
      "start-0",
      "end-4",
      "border-s",
      "border-e-2",
      "text-start",
      "text-end",
      "inset-x-0",
      "inset-y-0",
      "gap-3",
      "gap-x-2",
      "-translate-x-1/2",
      "mx-auto",
      "px-4",
    ]) {
      expect(physicalViolation(token), token).toBeUndefined();
    }
  });

  it("does not mistake a longer utility for a banned prefix", () => {
    // `rounded-lg` contains `rounded-l`; `border-e` contains no `border-l`.
    for (const token of [
      "rounded-lg",
      "rounded-xl",
      "rounded-full",
      "rounded-md",
      "border-2",
      "leading-6",
      "placeholder-left",
    ]) {
      expect(physicalViolation(token), token).toBeUndefined();
    }
  });

  it("does not mistake prose for a utility", () => {
    // The regression that made `VALUE` necessary: a test named "reads
    // right-to-left" failed the build, advising `end-to-left`.
    for (const token of [
      "right-to-left",
      "left-to-right",
      "left-aligned",
      "right-hand",
      "ml-ish",
    ]) {
      expect(physicalViolation(token), token).toBeUndefined();
    }
  });
});

describe("checkSource", () => {
  it("reports nothing for a file using logical utilities", () => {
    expect(
      checkSource("a.tsx", `const a = <div className="ms-4 text-start" />;`),
    ).toEqual([]);
  });

  it("reports each offending token with its line", () => {
    const violations = checkSource(
      "a.tsx",
      `const a = <div className="flex ml-4" />;\nconst b = <p className="text-right" />;`,
    );

    expect(violations).toEqual([
      { file: "a.tsx", line: 1, token: "ml-4", instead: "ms-4" },
      { file: "a.tsx", line: 2, token: "text-right", instead: "text-end" },
    ]);
  });

  it("ignores physical utilities that only appear in a comment", () => {
    expect(
      checkSource("a.tsx", `// use ms-4, never "ml-4"\nconst a = 1;`),
    ).toEqual([]);
  });
});

describe("formatViolations", () => {
  it("prints file, line, token and advice", () => {
    expect(
      formatViolations([
        { file: "a.tsx", line: 7, token: "ml-4", instead: "ms-4" },
      ]),
    ).toBe("  1. a.tsx:7 — `ml-4` → write `ms-4` instead");
  });
});

describe("the tree this repository ships", () => {
  it("uses no physical direction", () => {
    // The same assertion the build job makes, in the unit suite so a physical
    // utility fails in seconds rather than after a full build.
    const files = sourceFiles("src");
    const violations = files.flatMap((file) =>
      checkSource(file, readFileSync(file, "utf8")),
    );

    expect(formatViolations(violations)).toBe("");
  });

  it("scans the whole source tree", () => {
    const files = sourceFiles("src");
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("src/components/nav/app-shell.tsx");
  });

  it("scans only TypeScript sources", () => {
    for (const file of sourceFiles("src")) {
      expect(file, file).toMatch(/\.tsx?$/u);
    }
  });

  it("has a rule for every allowed exception's family", () => {
    // An entry in ALLOWED that no rule would have flagged is dead weight, and
    // reads as if it were protecting something.
    for (const token of ALLOWED) {
      expect(
        RULES.some((rule) => rule.pattern.test(token)),
        token,
      ).toBe(true);
    }
  });
});
