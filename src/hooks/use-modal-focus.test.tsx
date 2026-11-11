import * as React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useModalFocus } from "./use-modal-focus";

/**
 * A minimal stand-in for `<DialogContent>`: a panel that renders only while
 * open, attaches through state exactly as the real one does, and is focusable
 * itself.
 */
function Overlay({
  open,
  children,
}: {
  open: boolean;
  children?: React.ReactNode;
}) {
  const [panel, setPanel] = React.useState<HTMLDivElement | null>(null);
  useModalFocus(open, panel);
  return (
    <>
      <button type="button">trigger</button>
      {open && (
        <div ref={setPanel} role="dialog" tabIndex={-1} data-testid="panel">
          {children ?? (
            <>
              <button type="button">first</button>
              <button type="button">last</button>
            </>
          )}
        </div>
      )}
    </>
  );
}

const panel = (): HTMLElement => screen.getByTestId("panel");

const tab = (shiftKey = false): boolean =>
  !panel().dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );

describe("useModalFocus", () => {
  it("moves the focus to the first control when the overlay opens", () => {
    const view = render(<Overlay open={false} />);
    screen.getByRole("button", { name: "trigger" }).focus();

    view.rerender(<Overlay open />);

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "first" }),
    );
  });

  it("falls back to the panel when there is nothing focusable in it", () => {
    const view = render(<Overlay open={false}>nothing here</Overlay>);
    view.rerender(<Overlay open>nothing here</Overlay>);
    expect(document.activeElement).toBe(panel());
  });

  it("leaves a focus the content placed itself", () => {
    // `autoFocus` on the create-post dialog's title field is this case. Taking
    // over would move the caret off the field someone is about to type in and
    // onto the close button, which is first in the panel's DOM order.
    function WithAutoFocus({ open }: { open: boolean }) {
      return (
        <Overlay open={open}>
          <button type="button">close</button>
          <input autoFocus aria-label="title" />
        </Overlay>
      );
    }
    const view = render(<WithAutoFocus open={false} />);
    view.rerender(<WithAutoFocus open />);

    expect(document.activeElement).toBe(screen.getByLabelText("title"));
  });

  it("returns the focus to whatever opened it", () => {
    const view = render(<Overlay open={false} />);
    const trigger = screen.getByRole("button", { name: "trigger" });
    trigger.focus();
    view.rerender(<Overlay open />);
    expect(document.activeElement).not.toBe(trigger);

    view.rerender(<Overlay open={false} />);

    expect(document.activeElement).toBe(trigger);
  });

  it("does not restore to a trigger that has left the document", () => {
    // The focus is deliberately left where it is rather than sent to `<body>`:
    // whoever removed the trigger is the one who knows where the focus went.
    function Removable({ open, trigger }: { open: boolean; trigger: boolean }) {
      const [panelEl, setPanelEl] = React.useState<HTMLDivElement | null>(null);
      useModalFocus(open, panelEl);
      return (
        <>
          {trigger && <button type="button">trigger</button>}
          {open && (
            <div
              ref={setPanelEl}
              role="dialog"
              tabIndex={-1}
              data-testid="panel"
            >
              <button type="button">first</button>
            </div>
          )}
        </>
      );
    }
    const view = render(<Removable open={false} trigger />);
    const trigger = screen.getByRole("button", { name: "trigger" });
    trigger.focus();
    view.rerender(<Removable open trigger />);
    view.rerender(<Removable open={false} trigger={false} />);

    expect(trigger.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(trigger);
  });

  it("wraps Tab from the last control back to the first", () => {
    const view = render(<Overlay open={false} />);
    view.rerender(<Overlay open />);
    screen.getByRole("button", { name: "last" }).focus();

    expect(tab()).toBe(true); // the default was prevented
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "first" }),
    );
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    const view = render(<Overlay open={false} />);
    view.rerender(<Overlay open />);
    screen.getByRole("button", { name: "first" }).focus();

    expect(tab(true)).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "last" }),
    );
  });

  it("wraps Shift+Tab from the panel itself", () => {
    // The panel is at neither end of the cycle, which is why the wrap is
    // written as "where would Tab go from here" rather than "which end is
    // this".
    const view = render(<Overlay open={false} />);
    view.rerender(<Overlay open />);
    panel().focus();

    expect(tab(true)).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "last" }),
    );
  });

  it("leaves Tab alone in the middle of the cycle", () => {
    // jsdom performs no sequential focus navigation, so the assertion that
    // matters here is that the default was *not* prevented — the browser is
    // what moves the focus, and the end-to-end suite is what checks that it
    // stays inside.
    function Three({ open }: { open: boolean }) {
      return (
        <Overlay open={open}>
          <button type="button">first</button>
          <button type="button">middle</button>
          <button type="button">last</button>
        </Overlay>
      );
    }
    const view = render(<Three open={false} />);
    view.rerender(<Three open />);
    screen.getByRole("button", { name: "middle" }).focus();

    expect(tab()).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "middle" }),
    );
  });

  it("keeps the focus on the panel when the cycle is empty", () => {
    const view = render(<Overlay open={false}>nothing here</Overlay>);
    view.rerender(<Overlay open>nothing here</Overlay>);

    expect(tab()).toBe(true);
    expect(document.activeElement).toBe(panel());
  });
});
