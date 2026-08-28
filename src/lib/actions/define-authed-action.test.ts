import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { z } from "zod";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import {
  FORBIDDEN_MESSAGE,
  UNAUTHENTICATED_MESSAGE,
  defineAuthedAction,
  defineAuthedFormAction,
} from "@/lib/actions/define-authed-action";
import { ORIGIN_REJECTED_MESSAGE } from "@/lib/actions/origin";
import { setRequestHeaders } from "@/test/request-headers";

const mockAuth = vi.mocked(auth as () => Promise<Session | null>);

function signedIn(
  overrides: Partial<{ id: string; role: "USER" | "ADMIN" }> = {},
): void {
  mockAuth.mockResolvedValue({
    user: { id: "user-1", role: "USER", ...overrides },
    expires: "2099-01-01T00:00:00.000Z",
  } as unknown as Session);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("defineAuthedAction", () => {
  const whoami = defineAuthedAction({
    name: "whoami",
    input: z.object({ note: z.string().min(1, "Note is required") }),
    handler: ({ input, user }) => `${user.id}:${input.note}`,
  });

  it("hands the handler a user that cannot be null", async () => {
    signedIn({ id: "user-7" });

    await expect(whoami({ note: "hi" })).resolves.toEqual({
      success: true,
      data: "user-7:hi",
    });
  });

  it("refuses an anonymous caller", async () => {
    await expect(whoami({ note: "hi" })).resolves.toEqual({
      success: false,
      error: UNAUTHENTICATED_MESSAGE,
    });
  });

  it("lets an action word its own refusal", async () => {
    const action = defineAuthedAction({
      name: "custom",
      input: z.object({}),
      unauthenticatedMessage: "You must be signed in to create a post.",
      handler: () => null,
    });

    await expect(action({})).resolves.toEqual({
      success: false,
      error: "You must be signed in to create a post.",
    });
  });

  it("checks the session before the schema", async () => {
    // An anonymous caller should learn "sign in", not a field-by-field
    // description of the payload that would have worked.
    const result = await whoami({} as unknown as { note: string });

    expect(result).toEqual({
      success: false,
      error: UNAUTHENTICATED_MESSAGE,
    });
  });

  it("checks the origin before the session", async () => {
    signedIn();
    setRequestHeaders({
      origin: "https://evil.example",
      host: "localhost:3000",
    });

    await expect(whoami({ note: "hi" })).resolves.toEqual({
      success: false,
      error: ORIGIN_REJECTED_MESSAGE,
    });
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("rejects a session whose user has no id", async () => {
    // A JWT minted before the `id` callback existed deserialises to this. Every
    // Prisma query would then filter on `undefined`, which Prisma reads as "no
    // filter" rather than "no rows" — in a mutation, that is the difference
    // between touching one row and touching all of them.
    mockAuth.mockResolvedValue({
      user: { role: "USER" },
      expires: "2099-01-01T00:00:00.000Z",
    } as unknown as Session);

    await expect(whoami({ note: "hi" })).resolves.toEqual({
      success: false,
      error: UNAUTHENTICATED_MESSAGE,
    });
  });

  it("distinguishes a missing role from a missing session", async () => {
    const adminOnly = defineAuthedAction({
      name: "adminOnly",
      input: z.object({}),
      role: "ADMIN",
      handler: () => "secret",
    });

    signedIn({ role: "USER" });
    await expect(adminOnly({})).resolves.toEqual({
      success: false,
      error: FORBIDDEN_MESSAGE,
    });

    signedIn({ role: "ADMIN" });
    await expect(adminOnly({})).resolves.toEqual({
      success: true,
      data: "secret",
    });
  });

  it("gives each concurrent call its own user", async () => {
    // The version of this factory that resolved the session into a variable the
    // handler closed over passed every other test in this file and failed this
    // one. The factory runs once, at module scope, so that variable is shared
    // by every invocation — and the `await` between writing it and reading it
    // is exactly the window a second request slots into. Two people mutating at
    // the same moment would have been enough to swap them.
    //
    // The window is one microtask wide, which is what makes it easy to miss and
    // impossible to hope for: `await prepare()` yields between writing the
    // session and reading it, and that is the whole gap. So both sessions
    // resolve immediately — a timer would separate the two requests cleanly and
    // the shared-variable version would pass. Verified against that version:
    // with these mocks it reports `first=bob`.
    const session = (id: string): Session =>
      ({
        user: { id, role: "USER" },
        expires: "2099-01-01T00:00:00.000Z",
      }) as unknown as Session;

    mockAuth
      .mockImplementationOnce(async () => session("alice"))
      .mockImplementationOnce(async () => session("bob"));

    const seen: string[] = [];
    const slow = defineAuthedAction({
      name: "slow",
      input: z.object({ id: z.string() }),
      handler: async ({ input, user }) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        seen.push(`${input.id}=${user.id}`);
        return user.id;
      },
    });

    const results = await Promise.all([
      slow({ id: "first" }),
      slow({ id: "second" }),
    ]);

    expect(seen).toEqual(["first=alice", "second=bob"]);
    expect(results).toEqual([
      { success: true, data: "alice" },
      { success: true, data: "bob" },
    ]);
  });
});

describe("defineAuthedFormAction", () => {
  const rename = defineAuthedFormAction({
    name: "rename",
    input: z.object({ name: z.string().min(2, "Too short") }),
    handler: ({ input, user }) => `${user.id}:${input.name}`,
  });

  function form(name: string): FormData {
    const data = new FormData();
    data.set("name", name);
    return data;
  }

  it("runs with a session", async () => {
    signedIn({ id: "user-3" });

    await expect(rename(null, form("Ada"))).resolves.toEqual({
      success: true,
      data: "user-3:Ada",
    });
  });

  it("refuses an anonymous submission", async () => {
    await expect(rename(null, form("Ada"))).resolves.toEqual({
      success: false,
      error: UNAUTHENTICATED_MESSAGE,
    });
  });

  it("still validates once signed in", async () => {
    signedIn();

    await expect(rename(null, form("A"))).resolves.toEqual({
      success: false,
      error: "Too short",
      fieldErrors: { name: ["Too short"] },
    });
  });
});
