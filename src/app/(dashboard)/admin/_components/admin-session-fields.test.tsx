// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@/lib/session", () => ({
  getRequiredAdminSession: vi.fn(),
}));

import { getRequiredAdminSession } from "@/lib/session";
import type { AuthSession } from "@/lib/session";
import {
  AdminSessionFields,
  AdminSessionFieldsFallback,
} from "./admin-session-fields";

const mockGetRequiredAdminSession = vi.mocked(getRequiredAdminSession);

function labelsOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll("dt")].map(
    (dt) => dt.textContent ?? "",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRequiredAdminSession.mockResolvedValue({
    user: {
      id: "admin-7",
      role: "ADMIN",
      name: "Ada Lovelace",
      email: "ada@example.com",
    },
    expires: "2099-01-01",
  } as AuthSession);
});

describe("AdminSessionFields", () => {
  it("renders the administrator's session values", async () => {
    const { container } = render(await AdminSessionFields());

    expect(container.textContent).toContain("Ada Lovelace");
    expect(container.textContent).toContain("ada@example.com");
    expect(container.textContent).toContain("ADMIN");
    expect(container.textContent).toContain("admin-7");
  });

  it("asserts the admin role before rendering anything", async () => {
    // The proxy already turned away non-admins via ADMIN_PREFIXES; this is the
    // check next to the data, and it must still throw rather than render a
    // panel to whoever got past the first one.
    mockGetRequiredAdminSession.mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(AdminSessionFields()).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("AdminSessionFieldsFallback", () => {
  it("lists the same labels, in the same order, as the resolved fields", async () => {
    const fallback = render(<AdminSessionFieldsFallback />);
    const fallbackLabels = labelsOf(fallback.container);
    fallback.unmount();

    const resolved = render(await AdminSessionFields());

    expect(fallbackLabels).toEqual(["Name", "Email", "Role", "User ID"]);
    expect(labelsOf(resolved.container)).toEqual(fallbackLabels);
  });

  it("draws one skeleton per value", () => {
    const { container } = render(<AdminSessionFieldsFallback />);

    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4);
  });
});
