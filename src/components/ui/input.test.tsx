// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input } from "./input";

describe("Input", () => {
  it("renders an input element", () => {
    render(<Input placeholder="Enter text" />);
    expect(screen.getByPlaceholderText("Enter text")).toBeInTheDocument();
  });

  it("accepts user input", async () => {
    render(<Input data-testid="input" />);
    const input = screen.getByTestId("input") as HTMLInputElement;
    await userEvent.type(input, "hello");
    expect(input.value).toBe("hello");
  });

  it("is disabled when disabled prop is set", () => {
    render(<Input disabled placeholder="disabled" />);
    expect(screen.getByPlaceholderText("disabled")).toBeDisabled();
  });

  it("forwards type prop", () => {
    render(<Input type="email" placeholder="email" />);
    expect(screen.getByPlaceholderText("email")).toHaveAttribute("type", "email");
  });

  it("applies custom className", () => {
    const { container } = render(<Input className="my-input" />);
    expect(container.firstChild).toHaveClass("my-input");
  });

  it("forwards ref", () => {
    const ref = React.createRef<HTMLInputElement>();
    render(<Input ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it("calls onChange handler", async () => {
    const onChange = vi.fn();
    render(<Input onChange={onChange} data-testid="input" />);
    await userEvent.type(screen.getByTestId("input"), "a");
    expect(onChange).toHaveBeenCalled();
  });
});
