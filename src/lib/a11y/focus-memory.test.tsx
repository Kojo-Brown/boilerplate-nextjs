import { afterEach, describe, expect, it } from "vitest";
import {
  createFocusMemory,
  recallFocusedElement,
  rememberFocusedElement,
} from "./focus-memory";

/**
 * A `.test.tsx` rather than `.test.ts` so it runs in the jsdom project: these
 * functions are about `HTMLElement`, `document.body` and `isConnected`, none of
 * which exist in the node environment the `.test.ts` suite uses.
 */

function attach(tag = "a"): HTMLElement {
  const element = document.createElement(tag);
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("focus memory", () => {
  it("remembers an element per pathname", () => {
    const memory = createFocusMemory();
    const tile = attach();

    expect(rememberFocusedElement(memory, "/photos", tile)).toBe(true);
    expect(recallFocusedElement(memory, "/photos")).toBe(tile);
  });

  it("keeps routes apart", () => {
    const memory = createFocusMemory();
    const tile = attach();
    const button = attach("button");

    rememberFocusedElement(memory, "/photos", tile);
    rememberFocusedElement(memory, "/posts", button);

    expect(recallFocusedElement(memory, "/photos")).toBe(tile);
    expect(recallFocusedElement(memory, "/posts")).toBe(button);
  });

  it("keeps only the most recent element for a route", () => {
    const memory = createFocusMemory();
    const first = attach();
    const second = attach();

    rememberFocusedElement(memory, "/photos", first);
    rememberFocusedElement(memory, "/photos", second);

    expect(recallFocusedElement(memory, "/photos")).toBe(second);
  });

  it("has nothing for a route never visited", () => {
    expect(recallFocusedElement(createFocusMemory(), "/pricing")).toBeNull();
  });

  it("refuses <body>", () => {
    // <body> becomes `activeElement` whenever a focused element is removed,
    // so without this every route's memory is the body a frame after leaving
    // it — and every Back press restores focus to nothing while suppressing
    // the <main> fallback that would have been correct.
    const memory = createFocusMemory();

    expect(rememberFocusedElement(memory, "/posts", document.body)).toBe(false);
    expect(recallFocusedElement(memory, "/posts")).toBeNull();
  });

  it("refuses a target that is not an element", () => {
    const memory = createFocusMemory();

    expect(rememberFocusedElement(memory, "/posts", null)).toBe(false);
    expect(rememberFocusedElement(memory, "/posts", document)).toBe(false);
    expect(rememberFocusedElement(memory, "/posts", window)).toBe(false);
    expect(recallFocusedElement(memory, "/posts")).toBeNull();
  });

  it("does not recall an element that has left the document", () => {
    // The route was unmounted while the visitor was away. The `WeakRef` still
    // derefs — this map holds it, so does React — and focusing a detached node
    // moves focus to nowhere: `activeElement` falls back to the body and the
    // next Tab starts from the top of the page.
    const memory = createFocusMemory();
    const tile = attach();
    rememberFocusedElement(memory, "/photos", tile);

    tile.remove();

    expect(recallFocusedElement(memory, "/photos")).toBeNull();
  });

  it("does not recall an element the browser reports as invisible", () => {
    // Next keeps the page you navigated away from mounted and hidden so Back
    // can be instant, so a remembered element from the outgoing route is
    // still connected and still answers to `getElementById` — while
    // `focus()` on it does nothing and reports nothing. Measured on a real
    // Back press before this guard existed.
    const memory = createFocusMemory();
    const tile = attach();
    tile.checkVisibility = () => false;
    rememberFocusedElement(memory, "/photos", tile);

    expect(recallFocusedElement(memory, "/photos")).toBeNull();
  });

  it("recalls an element the browser reports as visible", () => {
    const memory = createFocusMemory();
    const tile = attach();
    tile.checkVisibility = () => true;
    rememberFocusedElement(memory, "/photos", tile);

    expect(recallFocusedElement(memory, "/photos")).toBe(tile);
  });

  it("treats a missing checkVisibility as visible", () => {
    // jsdom performs no layout and implements neither `checkVisibility` nor a
    // meaningful `offsetParent`, so there is no question to answer here —
    // reading absence as "not visible" would make every restore in the unit
    // suite fall through to the landmark and the suite would assert nothing.
    const memory = createFocusMemory();
    const tile = attach();
    expect(tile.checkVisibility).toBeUndefined();
    rememberFocusedElement(memory, "/photos", tile);

    expect(recallFocusedElement(memory, "/photos")).toBe(tile);
  });

  it("recalls an element that was re-parented but is still in the document", () => {
    const memory = createFocusMemory();
    const tile = attach();
    rememberFocusedElement(memory, "/photos", tile);

    const section = attach("section");
    section.append(tile);

    expect(recallFocusedElement(memory, "/photos")).toBe(tile);
  });
});
