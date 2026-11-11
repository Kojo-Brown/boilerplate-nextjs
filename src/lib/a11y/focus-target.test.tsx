import { describe, expect, it } from "vitest";
import { canTakeFocus, focusableWithin } from "./focus-target";

function host(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  return container;
}

describe("canTakeFocus", () => {
  it("refuses an element that has left the document", () => {
    const element = document.createElement("button");
    document.body.append(element);
    expect(canTakeFocus(element)).toBe(true);

    element.remove();
    // Still a live object — this test holds a reference to it — which is the
    // whole reason `isConnected` is checked rather than assumed.
    expect(canTakeFocus(element)).toBe(false);
  });

  it("refuses an element the browser reports as not visible", () => {
    const element = document.createElement("button");
    document.body.append(element);
    // jsdom has no `checkVisibility`, so the guard's default is "visible" and
    // this is the only way to exercise the branch here. The claim that a
    // `display: none` element really is refused is asserted in the browser, in
    // `e2e/focus-management.spec.ts`.
    Object.defineProperty(element, "checkVisibility", {
      value: () => false,
      configurable: true,
    });
    expect(canTakeFocus(element)).toBe(false);
  });

  it("treats a missing checkVisibility as visible", () => {
    const element = document.createElement("button");
    document.body.append(element);
    expect(element.checkVisibility).toBeUndefined();
    expect(canTakeFocus(element)).toBe(true);
  });
});

describe("focusableWithin", () => {
  it("finds controls in document order", () => {
    const container = host(
      `<a href="/one">one</a><button>two</button><input /><textarea></textarea><select></select>`,
    );
    expect(focusableWithin(container).map((el) => el.tagName)).toEqual([
      "A",
      "BUTTON",
      "INPUT",
      "TEXTAREA",
      "SELECT",
    ]);
  });

  it("skips disabled controls and hidden inputs", () => {
    const container = host(
      `<button disabled>no</button><input type="hidden" /><button>yes</button>`,
    );
    expect(focusableWithin(container).map((el) => el.textContent)).toEqual([
      "yes",
    ]);
  });

  it("skips an anchor with no href, which cannot be tabbed to", () => {
    const container = host(`<a>no</a><a href="#x">yes</a>`);
    expect(focusableWithin(container).map((el) => el.textContent)).toEqual([
      "yes",
    ]);
  });

  it("excludes tabindex=-1, so a dialog panel is not its own first stop", () => {
    // The panel carries `tabIndex={-1}` purely so it can be focused
    // programmatically. Including it would put it in the tab cycle ahead of its
    // own close button, and the first Tab after opening a dialog would appear
    // to do nothing.
    const container = host(
      `<div tabindex="-1" id="panel"><button>close</button></div>`,
    );
    expect(focusableWithin(container).map((el) => el.textContent)).toEqual([
      "close",
    ]);
  });

  it("includes a positive or zero tabindex", () => {
    const container = host(`<div tabindex="0">yes</div>`);
    expect(focusableWithin(container)).toHaveLength(1);
  });

  it("omits a control the browser says is not visible", () => {
    const container = host(`<button>a</button><button>b</button>`);
    const [, second] = Array.from(container.querySelectorAll("button"));
    Object.defineProperty(second, "checkVisibility", {
      value: () => false,
      configurable: true,
    });
    expect(focusableWithin(container).map((el) => el.textContent)).toEqual([
      "a",
    ]);
  });
});
