import { describe, it, expect, vi, beforeEach } from "vitest";
import { draftMode } from "next/headers";
import { isPreviewEnabled } from "./draft";

/**
 * `next/headers` is mocked globally in `src/test/setup.ts` with draft mode off,
 * which is the state every other suite in this repository runs under. These
 * tests turn it on and back off to prove the reads underneath it actually
 * branch — the risk being a helper that returns `false` for a reason other than
 * the cookie, in which case nothing downstream would ever take the draft path
 * and every test of it would still pass.
 */
const mockDraftMode = vi.mocked(draftMode);

function draft(isEnabled: boolean) {
  mockDraftMode.mockResolvedValue({
    isEnabled,
    enable: vi.fn(),
    disable: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof draftMode>>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isPreviewEnabled", () => {
  it("is false when no preview cookie is present", async () => {
    draft(false);
    expect(await isPreviewEnabled()).toBe(false);
  });

  it("is true inside a draft session", async () => {
    draft(true);
    expect(await isPreviewEnabled()).toBe(true);
  });

  it("reads the flag rather than mutating draft mode", async () => {
    // `enable()`/`disable()` are the tracked-dynamic half of `draftMode()`.
    // Calling either from a page is what would push `/blog` out of its static
    // prerender, so this helper must never do it — see the module comment.
    const enable = vi.fn();
    const disable = vi.fn();
    mockDraftMode.mockResolvedValue({
      isEnabled: true,
      enable,
      disable,
    } as unknown as Awaited<ReturnType<typeof draftMode>>);

    await isPreviewEnabled();

    expect(enable).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
  });
});
