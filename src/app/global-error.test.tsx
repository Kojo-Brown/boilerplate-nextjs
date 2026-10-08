import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import GlobalError from "./global-error";

/**
 * This component exists for an accessibility contract rather than for a visual
 * one, so these cases are about the document it produces: a `lang`, a title,
 * and a reference a visitor can quote. Next's own default global-error document
 * is `<html id="__next_error__">` with no `lang` at all — a WCAG 3.1.1 failure —
 * and `scripts/assert-accessibility.ts` is what found it.
 *
 * `renderToStaticMarkup` rather than `render`: the component *is* the document,
 * and mounting an `<html>` inside a container element is a DOM-nesting warning
 * on every case for nothing in return. The reset button's wiring is the one
 * behavioural case, and it reads the prop rather than the DOM for the same
 * reason.
 */
function markup(props?: { digest?: string }) {
  const error = Object.assign(new Error("root layout exploded"), props ?? {});
  return renderToStaticMarkup(
    <GlobalError error={error} reset={() => undefined} />,
  );
}

describe("GlobalError", () => {
  it("renders a document with a language, which Next's default does not", () => {
    expect(markup()).toContain('<html lang="en">');
  });

  it("titles the document, so a tab and a screen reader both name it", () => {
    expect(markup()).toContain("<title>Something went wrong</title>");
  });

  it("puts the heading in a main landmark", () => {
    const html = markup();

    expect(html).toContain("<main");
    expect(html).toMatch(/<h1[^>]*>Something went wrong<\/h1>/);
  });

  it("carries its own styles, because the layout that links the stylesheet is what failed", () => {
    const html = markup();

    expect(html).toContain("<style>");
    // Both colour schemes, since the theme provider is in that same layout.
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("shows the digest when there is one, so the error can be reported", () => {
    expect(markup({ digest: "abc123" })).toContain("Error reference: abc123");
  });

  it("omits the reference line entirely when there is no digest", () => {
    expect(markup()).not.toContain("Error reference");
  });

  it("retries through the reset callback Next passes in", () => {
    const reset = vi.fn();
    const element = (
      <GlobalError error={new Error("boom")} reset={reset} />
    ) as React.ReactElement<{
      error: Error;
      reset: () => void;
    }>;
    // Rendering the element would mean mounting an `<html>`; the contract here
    // is that the button calls `reset`, which is a property of the tree.
    const tree = GlobalError(element.props);
    const button = findButton(tree);

    button.props.onClick();

    expect(reset).toHaveBeenCalledTimes(1);
  });
});

interface ButtonElement {
  props: { onClick: () => void };
}

/** Walks the rendered tree for the one `<button>` in it. */
function findButton(node: unknown): ButtonElement {
  const found = search(node);
  if (!found) throw new Error("GlobalError rendered no button");
  return found;
}

function search(node: unknown): ButtonElement | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = search(child);
      if (found) return found;
    }
    return null;
  }
  const element = node as {
    type?: unknown;
    props?: { children?: unknown; onClick?: () => void };
  };
  if (element.type === "button" && element.props?.onClick) {
    return element as ButtonElement;
  }
  return search(element.props?.children);
}
