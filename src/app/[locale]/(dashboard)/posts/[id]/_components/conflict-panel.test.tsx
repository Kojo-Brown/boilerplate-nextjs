// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mergeEditable } from "@/lib/concurrency/post-conflict";
import { ConflictPanel } from "./conflict-panel";

/**
 * The panel in isolation.
 *
 * `PostEditor`'s own suite covers what happens to the editor around it — the
 * rebase, the reopening on a third writer. What is only visible from here is
 * what the panel hands back for a given set of clicks, which is the half a
 * three-way merge can get subtly wrong without anything on screen looking odd.
 */
function panelFor(
  mine: { title: string; content: string | null },
  theirs: { title: string; content: string | null },
  onResolve = vi.fn(),
) {
  const merge = mergeEditable({
    base: { title: "Base title", content: "Base body" },
    mine,
    theirs,
  });

  render(
    <ConflictPanel merge={merge} theirVersion={4} onResolve={onResolve} />,
  );

  return onResolve;
}

describe("ConflictPanel", () => {
  it("hands back my text for a field left at its default", async () => {
    const onResolve = panelFor(
      { title: "My title", content: "Base body" },
      { title: "Their title", content: "Base body" },
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Apply to editor" }),
    );

    expect(onResolve).toHaveBeenCalledWith({
      title: "My title",
      content: "Base body",
    });
  });

  it("hands back their text once it is selected", async () => {
    const onResolve = panelFor(
      { title: "My title", content: "Base body" },
      { title: "Their title", content: "Base body" },
    );

    await userEvent.click(
      within(screen.getByTestId("conflict-title")).getByRole("radio", {
        name: /Use theirs/,
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Apply to editor" }),
    );

    expect(onResolve).toHaveBeenCalledWith({
      title: "Their title",
      content: "Base body",
    });
  });

  it("discards every one of my changes at once, however many are contested", async () => {
    const onResolve = panelFor(
      { title: "My title", content: "My body" },
      { title: "Their title", content: "Their body" },
    );

    // Deliberately after picking "keep mine" on one of them: "discard" is one
    // decision about the whole document, and a per-field choice made before it
    // must not survive.
    await userEvent.click(
      within(screen.getByTestId("conflict-title")).getByRole("radio", {
        name: /Keep mine/,
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Discard my changes" }),
    );

    expect(onResolve).toHaveBeenCalledWith({
      title: "Their title",
      content: "Their body",
    });
  });

  it("names an empty side rather than rendering nothing for it", async () => {
    panelFor(
      { title: "Base title", content: "My body" },
      { title: "Base title", content: null },
    );

    // An empty radio label is a choice with no visible consequence. "(empty)"
    // is what makes "they deleted the body" a thing the author can see they
    // are agreeing to.
    expect(
      within(screen.getByTestId("conflict-content")).getByText("(empty)"),
    ).toBeInTheDocument();
  });

  it("says what it took without asking", () => {
    panelFor(
      { title: "Base title", content: "My body" },
      { title: "Their title", content: "Base body" },
    );

    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByTestId("conflict-taken")).toHaveTextContent(
      "Keeping their title, which you had not edited.",
    );
  });

  it("announces itself once, rather than reading every version aloud", () => {
    panelFor(
      { title: "My title", content: "Base body" },
      { title: "Their title", content: "Base body" },
    );

    // The live region is the heading, not the section: the whole panel as one
    // would have a screen reader read both versions of every field before the
    // author could reach a control.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This post changed while you were editing",
    );
  });
});
