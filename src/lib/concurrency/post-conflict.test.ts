import { describe, it, expect } from "vitest";
import {
  applyResolutions,
  mergeEditable,
  EDITABLE_FIELDS,
} from "./post-conflict";
import type { EditableFields } from "./post-conflict";

/**
 * The three-way comparison, as the table in the module doc.
 *
 * Written against `title` because it is the field with no null case, so the
 * four rows are about the comparison and nothing else; `content` gets its own
 * block below for the two spellings of empty it has to fold.
 */
const base: EditableFields = { title: "Base title", content: "Base body" };

function merge(mine: Partial<EditableFields>, theirs: Partial<EditableFields>) {
  return mergeEditable({
    base,
    mine: { ...base, ...mine },
    theirs: { ...base, ...theirs },
  });
}

describe("mergeEditable", () => {
  it("keeps a field neither side touched", () => {
    const result = merge({}, {});

    expect(result.merged).toEqual(base);
    expect(result.conflicts).toEqual([]);
    expect(result.taken).toEqual([]);
  });

  it("keeps my change to a field they did not touch", () => {
    const result = merge({ title: "My title" }, {});

    expect(result.merged.title).toBe("My title");
    expect(result.conflicts).toEqual([]);
    expect(result.taken).toEqual([]);
  });

  it("takes their change to a field I did not touch, and says so", () => {
    const result = merge({}, { title: "Their title" });

    expect(result.merged.title).toBe("Their title");
    expect(result.conflicts).toEqual([]);
    // Reported rather than merged silently: the draft now contains a sentence
    // its author never typed.
    expect(result.taken).toEqual(["title"]);
  });

  it("reports a field both sides changed, with all three values", () => {
    const result = merge({ title: "My title" }, { title: "Their title" });

    expect(result.conflicts).toEqual([
      {
        field: "title",
        base: "Base title",
        mine: "My title",
        theirs: "Their title",
      },
    ]);
    // Unresolved conflicts sit at `mine`, so `merged` is always a complete set
    // of values rather than one with holes in it.
    expect(result.merged.title).toBe("My title");
  });

  it("asks nothing when both sides made the same change", () => {
    const result = merge({ title: "Same" }, { title: "Same" });

    expect(result.conflicts).toEqual([]);
    expect(result.merged.title).toBe("Same");
  });

  /**
   * The case a two-way comparison gets wrong, and the reason `base` is
   * threaded through at all.
   *
   * They retitled the post while I rewrote the body. Compared pairwise the two
   * documents differ in both fields and the author is made to choose which
   * colleague's work to destroy; compared against what both started from,
   * neither field is in conflict and the merge is exact.
   */
  it("merges disjoint edits without asking anything", () => {
    const result = merge({ content: "My body" }, { title: "Their title" });

    expect(result.conflicts).toEqual([]);
    expect(result.taken).toEqual(["title"]);
    expect(result.merged).toEqual({
      title: "Their title",
      content: "My body",
    });
  });

  it("reports both fields when both are genuinely contested", () => {
    const result = merge(
      { title: "My title", content: "My body" },
      { title: "Their title", content: "Their body" },
    );

    expect(result.conflicts.map((conflict) => conflict.field)).toEqual([
      ...EDITABLE_FIELDS,
    ]);
  });

  it("treats an emptied textarea and a null column as the same absence", () => {
    // `updatePostSchema` stores `""` as `null`, so the same emptiness arrives
    // spelled one way from the browser and the other from the database. Left
    // unfolded, this is a conflict between a value and itself — on the field
    // most likely to be empty.
    const result = mergeEditable({
      base: { title: "T", content: null },
      mine: { title: "T", content: "" },
      theirs: { title: "T", content: null },
    });

    expect(result.conflicts).toEqual([]);
    expect(result.merged.content).toBeNull();
  });

  it("sees clearing the body as a change like any other", () => {
    const result = mergeEditable({
      base: { title: "T", content: "Base body" },
      mine: { title: "T", content: "" },
      theirs: { title: "T", content: "Their body" },
    });

    expect(result.conflicts).toEqual([
      { field: "content", base: "Base body", mine: null, theirs: "Their body" },
    ]);
  });
});

describe("applyResolutions", () => {
  const contested = merge(
    { title: "My title", content: "My body" },
    { title: "Their title", content: "Their body" },
  );

  it("applies each choice to the field it names", () => {
    expect(
      applyResolutions(contested, { title: "theirs", content: "mine" }),
    ).toEqual({ title: "Their title", content: "My body" });
  });

  it("keeps my text for a field no choice was recorded for", () => {
    // The safe default rather than the polite one: their version is in the
    // database and survives being passed over, this one exists in one browser.
    expect(applyResolutions(contested, {})).toEqual({
      title: "My title",
      content: "My body",
    });
  });

  it("leaves the automatically merged fields alone", () => {
    const partial = merge({ content: "My body" }, { title: "Their title" });

    expect(applyResolutions(partial, {})).toEqual({
      title: "Their title",
      content: "My body",
    });
  });
});
