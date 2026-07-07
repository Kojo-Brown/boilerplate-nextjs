// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

import { toast, toastActionError } from "@/lib/toast";

describe("toast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-exports the sonner toast function", () => {
    expect(typeof toast).toBe("function");
    expect(typeof toast.success).toBe("function");
    expect(typeof toast.error).toBe("function");
  });
});

describe("toastActionError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls toast.error for a general error result", () => {
    toastActionError({ success: false, error: "Something went wrong." });
    expect(toast.error).toHaveBeenCalledWith("Something went wrong.");
  });

  it("does nothing when result is success", () => {
    toastActionError({ success: true, data: undefined });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does nothing when result has fieldErrors", () => {
    toastActionError({
      success: false,
      error: "Validation failed.",
      fieldErrors: { email: ["Invalid email."] },
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
