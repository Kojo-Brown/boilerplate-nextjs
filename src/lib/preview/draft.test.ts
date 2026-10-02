import { describe, it, expect, vi, beforeEach } from "vitest";
import { cookies, draftMode } from "next/headers";
import { PREVIEW_SCOPE_COOKIE, signPreviewScope } from "@/lib/preview/scope";
import { getPreviewScope, isPreviewEnabled } from "./draft";

/**
 * `next/headers` is mocked globally in `src/test/setup.ts` with draft mode off,
 * which is the state every other suite in this repository runs under. These
 * tests turn it on and back off to prove the reads underneath it actually
 * branch — the risk being a helper that returns `false` for a reason other than
 * the cookie, in which case nothing downstream would ever take the draft path
 * and every test of it would still pass.
 */
const mockDraftMode = vi.mocked(draftMode);
const mockCookies = vi.mocked(cookies);

const TENANT = "tenant-mock-a";

function draft(isEnabled: boolean) {
  mockDraftMode.mockResolvedValue({
    isEnabled,
    enable: vi.fn(),
    disable: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof draftMode>>);
}

/** A cookie jar holding `value` under the scope cookie's name, or nothing. */
function jar(value?: string) {
  const get = vi.fn((name: string) =>
    name === PREVIEW_SCOPE_COOKIE && value !== undefined
      ? { name, value }
      : undefined,
  );
  mockCookies.mockResolvedValue({ get } as unknown as Awaited<
    ReturnType<typeof cookies>
  >);
  return get;
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

describe("getPreviewScope", () => {
  it("is null outside a draft session, without reading a cookie", async () => {
    // The ordering this whole module rests on. `cookies()` is a tracked dynamic
    // access, so a read of it in `/blog`'s graph ends that route's static
    // prerender — and during a prerender `draftMode().isEnabled` is a plain
    // `false`, so the early return is what keeps the jar untouched. Asserted on
    // the mock rather than on the result, because a correct `null` says nothing
    // about whether the cookie was read on the way to it.
    draft(false);
    const get = jar(await signPreviewScope(TENANT));

    expect(await getPreviewScope()).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("resolves the workspace a valid cookie names", async () => {
    draft(true);
    jar(await signPreviewScope(TENANT));

    expect(await getPreviewScope()).toEqual({ tenantId: TENANT });
  });

  it("is null inside a draft session with no scope cookie", async () => {
    // Fails closed: the reads fall back to the published site rather than to
    // every workspace's drafts, which is what an unscoped preview used to mean.
    draft(true);
    jar();

    expect(await getPreviewScope()).toBeNull();
  });

  it("is null when the cookie names another workspace under a stolen signature", async () => {
    draft(true);
    const valid = await signPreviewScope(TENANT);
    jar(`tenant-mock-b.${valid.slice(valid.lastIndexOf(".") + 1)}`);

    expect(await getPreviewScope()).toBeNull();
  });

  it("is null for a cookie that is not a signed scope at all", async () => {
    draft(true);
    jar("tenant-mock-a");

    expect(await getPreviewScope()).toBeNull();
  });

  it("does not mutate draft mode", async () => {
    // Same property as `isPreviewEnabled`, and it matters more here: this
    // function is the one with a second request-scoped read in it, so it is the
    // one somebody will reach for when adding a third.
    const enable = vi.fn();
    const disable = vi.fn();
    mockDraftMode.mockResolvedValue({
      isEnabled: true,
      enable,
      disable,
    } as unknown as Awaited<ReturnType<typeof draftMode>>);
    jar(await signPreviewScope(TENANT));

    await getPreviewScope();

    expect(enable).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
  });
});
