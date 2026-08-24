// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@/lib/session", () => ({
  getRequiredSession: vi.fn(),
}));

import { getRequiredSession } from "@/lib/session";
import type { AuthSession } from "@/lib/session";
import {
  SessionFields,
  SessionFieldsFallback,
  SessionGreeting,
  SessionGreetingFallback,
} from "./session-summary";

const mockGetRequiredSession = vi.mocked(getRequiredSession);

function sessionWith(user: Partial<AuthSession["user"]>): AuthSession {
  return {
    user: { id: "user-1", role: "USER", ...user },
    expires: "2099-01-01",
  } as AuthSession;
}

/** `<dt>` text in document order — the labels a reader sees down the card. */
function labelsOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll("dt")].map(
    (dt) => dt.textContent ?? "",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRequiredSession.mockResolvedValue(
    sessionWith({
      name: "Grace Hopper",
      email: "grace@example.com",
      role: "ADMIN",
      id: "user-42",
    }),
  );
});

describe("SessionFields", () => {
  it("renders each session value against its label", async () => {
    const { container } = render(await SessionFields());

    expect(container.textContent).toContain("Grace Hopper");
    expect(container.textContent).toContain("grace@example.com");
    expect(container.textContent).toContain("ADMIN");
    expect(container.textContent).toContain("user-42");
  });

  it("shows an em dash for a value the provider did not supply", async () => {
    mockGetRequiredSession.mockResolvedValue(sessionWith({ email: null }));

    const { container } = render(await SessionFields());

    // Not an empty cell: the row keeps its height, so the card does not change
    // shape depending on how complete a profile is.
    expect(container.textContent).toContain("—");
  });
});

describe("SessionFieldsFallback", () => {
  it("prerenders the labels rather than a grey box in their place", async () => {
    const { container } = render(<SessionFieldsFallback />);

    // The labels are page markup — the same four words for every visitor — so
    // there is no reason for a reader to wait on a cookie to see them.
    expect(labelsOf(container)).toEqual(["Name", "Email", "Role", "User ID"]);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4);
  });

  it("lists the same labels, in the same order, as the resolved fields", async () => {
    // The property that keeps a fallback honest. Both are driven off
    // SESSION_FIELDS, and this fails the moment one of them stops being.
    const fallback = render(<SessionFieldsFallback />);
    const fallbackLabels = labelsOf(fallback.container);
    fallback.unmount();

    const resolved = render(await SessionFields());

    expect(labelsOf(resolved.container)).toEqual(fallbackLabels);
  });
});

describe("SessionGreeting", () => {
  it("greets the signed-in user by name", async () => {
    const { container } = render(await SessionGreeting());

    expect(container.textContent).toBe("Welcome back, Grace Hopper!");
  });

  it("greets an account with no name without leaving a gap", async () => {
    mockGetRequiredSession.mockResolvedValue(sessionWith({ name: null }));

    const { container } = render(await SessionGreeting());

    expect(container.textContent).toBe("Welcome back, there!");
  });

  it("reserves the greeting's height while it streams", () => {
    const { container } = render(<SessionGreetingFallback />);

    // `h-5` is the line box of the `text-sm` paragraph it stands in for. A
    // fallback of a different height moves the card below it when the hole
    // fills, which is the most common way streaming ends up feeling worse than
    // waiting.
    expect(container.firstElementChild?.className).toContain("h-5");
  });
});
