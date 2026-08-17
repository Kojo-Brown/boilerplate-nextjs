import { describe, expect, it } from "vitest";
import { toParagraphs } from "./prose";

describe("toParagraphs", () => {
  it("returns a single paragraph for content with no blank line", () => {
    expect(toParagraphs("One block of text.")).toEqual(["One block of text."]);
  });

  it("splits on a blank line", () => {
    expect(toParagraphs("First.\n\nSecond.")).toEqual(["First.", "Second."]);
  });

  it("keeps single newlines inside a paragraph, since the page renders them", () => {
    // `whitespace-pre-wrap` on the rendered `<p>` is what makes this
    // meaningful: a deliberate line break has to survive as a line break
    // rather than being promoted to a paragraph or flattened into a space.
    expect(toParagraphs("Line one\nline two\n\nNext.")).toEqual([
      "Line one\nline two",
      "Next.",
    ]);
  });

  it("collapses a run of blank lines into one break rather than emitting empty paragraphs", () => {
    expect(toParagraphs("First.\n\n\n\nSecond.")).toEqual([
      "First.",
      "Second.",
    ]);
  });

  it("treats a whitespace-only line as blank", () => {
    // A textarea readily produces these — a stray space or tab left on the
    // line the author used to separate two paragraphs. Matching only on
    // `\n\n` would render both halves as one paragraph.
    expect(toParagraphs("First.\n   \nSecond.")).toEqual(["First.", "Second."]);
    expect(toParagraphs("First.\n\t\nSecond.")).toEqual(["First.", "Second."]);
  });

  it("handles CRLF, which is what a submitted textarea contains", () => {
    expect(toParagraphs("First.\r\n\r\nSecond.")).toEqual([
      "First.",
      "Second.",
    ]);
  });

  it("trims leading and trailing whitespace off every paragraph", () => {
    expect(toParagraphs("\n\n  First.  \n\n  Second.\n\n")).toEqual([
      "First.",
      "Second.",
    ]);
  });

  it("returns nothing for absent or empty content", () => {
    // `Post.content` is nullable in the schema, and the page branches on the
    // empty array to render its "No content yet." fallback.
    expect(toParagraphs(null)).toEqual([]);
    expect(toParagraphs(undefined)).toEqual([]);
    expect(toParagraphs("")).toEqual([]);
  });

  it("returns nothing for content that is only whitespace", () => {
    expect(toParagraphs("   \n\n \t \n")).toEqual([]);
  });

  it("never yields an empty or untrimmed paragraph, whatever the input", () => {
    const inputs = [
      "a\n\nb\n\n\nc",
      "\r\n\r\na\r\n\r\n",
      " \n a \n \n b \n ",
      "one",
      "\n",
    ];

    for (const input of inputs) {
      for (const paragraph of toParagraphs(input)) {
        expect(paragraph).not.toBe("");
        expect(paragraph).toBe(paragraph.trim());
      }
    }
  });
});
