// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastDemo } from "./toast-demo";

vi.mock("@/lib/toast", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(() => "toast-id"),
    promise: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

import { toast } from "@/lib/toast";

describe("ToastDemo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all variant buttons", () => {
    render(<ToastDemo />);
    expect(screen.getByRole("button", { name: "Success" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Error" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Warning" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Info" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Loading → Success" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Promise" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss all" })).toBeInTheDocument();
  });

  it("calls toast.success when Success is clicked", async () => {
    render(<ToastDemo />);
    await userEvent.click(screen.getByRole("button", { name: "Success" }));
    expect(toast.success).toHaveBeenCalledWith("Changes saved successfully.");
  });

  it("calls toast.error when Error is clicked", async () => {
    render(<ToastDemo />);
    await userEvent.click(screen.getByRole("button", { name: "Error" }));
    expect(toast.error).toHaveBeenCalledWith(
      "Something went wrong. Please try again.",
    );
  });

  it("calls toast.warning when Warning is clicked", async () => {
    render(<ToastDemo />);
    await userEvent.click(screen.getByRole("button", { name: "Warning" }));
    expect(toast.warning).toHaveBeenCalledWith(
      "Your session expires in 5 minutes.",
    );
  });

  it("calls toast.info when Info is clicked", async () => {
    render(<ToastDemo />);
    await userEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(toast.info).toHaveBeenCalledWith("A new version is available.");
  });

  it("calls toast.loading when Loading → Success is clicked", async () => {
    render(<ToastDemo />);
    await userEvent.click(screen.getByRole("button", { name: "Loading → Success" }));
    expect(toast.loading).toHaveBeenCalledWith("Uploading file…");
  });

  it("calls toast.promise when Promise is clicked", async () => {
    render(<ToastDemo />);
    await userEvent.click(screen.getByRole("button", { name: "Promise" }));
    expect(toast.promise).toHaveBeenCalledWith(
      expect.any(Promise),
      expect.objectContaining({
        loading: "Generating report…",
        error: "Failed to generate report.",
      }),
    );
  });

  it("calls toast.dismiss when Dismiss all is clicked", async () => {
    render(<ToastDemo />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss all" }));
    expect(toast.dismiss).toHaveBeenCalled();
  });
});
