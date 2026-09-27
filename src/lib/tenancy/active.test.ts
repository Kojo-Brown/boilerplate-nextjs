import { describe, it, expect, vi, beforeEach } from "vitest";

const { cookieStore, membershipRows, userScopes } = vi.hoisted(() => ({
  cookieStore: new Map<string, string>(),
  membershipRows: [] as unknown[],
  userScopes: [] as string[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieStore.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    // Next's `redirect` throws; a mock that returns would let the code after
    // it run, which is the opposite of what the real one guarantees.
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("@/lib/session", () => ({
  getRequiredSession: vi.fn(),
}));

/**
 * The membership read is mocked at the transaction boundary rather than at the
 * DAL, so the test can see *which scope* it was issued in. That is the
 * property worth pinning: the read has to carry a user and deliberately no
 * tenant, because `memberships_own_read` is the policy that answers it and a
 * tenant-scoped connection would match nothing.
 */
vi.mock("@/lib/tenancy/client", () => ({
  withUserTransaction: (
    userId: string,
    fn: (tx: unknown) => Promise<unknown>,
  ) => {
    userScopes.push(userId);
    return fn({ membership: { findMany: async () => membershipRows } });
  },
}));

import { getRequiredSession } from "@/lib/session";
import {
  ACTIVE_TENANT_COOKIE,
  getActiveTenant,
  getMembershipsForUser,
  getRequiredTenant,
} from "./active";
import type { AuthSession } from "@/lib/session";

const session = {
  user: { id: "user-1", role: "USER", email: "ada@example.test" },
  expires: "2099-01-01",
} as AuthSession;

function row(tenantId: string, slug: string, role = "MEMBER") {
  return { tenantId, role, tenant: { slug, name: slug.toUpperCase() } };
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieStore.clear();
  membershipRows.length = 0;
  userScopes.length = 0;
  vi.mocked(getRequiredSession).mockResolvedValue(session);
});

describe("getMembershipsForUser", () => {
  it("reads with a user and no tenant", async () => {
    membershipRows.push(row("tenant-1", "acme", "OWNER"));

    await getMembershipsForUser("user-1");

    // The read that decides which tenant may be opened cannot be made inside
    // one. If this ever moves onto a tenant-scoped client it returns nothing,
    // and every signed-in user lands on /forbidden.
    expect(userScopes).toEqual(["user-1"]);
  });

  it("flattens the tenant relation into the membership", async () => {
    membershipRows.push(row("tenant-1", "acme", "OWNER"));

    expect(await getMembershipsForUser("user-1")).toEqual([
      { tenantId: "tenant-1", slug: "acme", name: "ACME", role: "OWNER" },
    ]);
  });
});

describe("getActiveTenant", () => {
  it("returns the first membership when no cookie names one", async () => {
    // A fresh sign-in has no preference yet, and every user has at least one
    // workspace — see `@/lib/tenancy/provision`.
    membershipRows.push(row("tenant-1", "acme"), row("tenant-2", "globex"));

    const active = await getActiveTenant();

    expect(active?.tenantId).toBe("tenant-1");
  });

  it("returns the tenant the cookie names, when the user is a member", async () => {
    membershipRows.push(row("tenant-1", "acme"), row("tenant-2", "globex"));
    cookieStore.set(ACTIVE_TENANT_COOKIE, "tenant-2");

    const active = await getActiveTenant();

    expect(active?.tenantId).toBe("tenant-2");
    expect(active?.slug).toBe("globex");
  });

  it("carries a scope with both halves", async () => {
    membershipRows.push(row("tenant-1", "acme"));

    expect((await getActiveTenant())?.scope).toEqual({
      tenantId: "tenant-1",
      userId: "user-1",
    });
  });

  it("refuses a cookie naming a tenant the user is not a member of", async () => {
    // The cookie is a request, not evidence. This is the assertion that makes
    // that true: a value the client chose does not become a scope.
    membershipRows.push(row("tenant-1", "acme"));
    cookieStore.set(ACTIVE_TENANT_COOKIE, "tenant-someone-elses");

    expect(await getActiveTenant()).toBeNull();
  });

  it("does not fall back to the first tenant when the cookie is wrong", async () => {
    // Falling back would answer a request that explicitly asked for tenant B
    // with tenant A's data. Every value on the page would be real and none of
    // it would be the workspace the reader believes they are looking at —
    // which is far harder to notice than an error.
    membershipRows.push(row("tenant-1", "acme"), row("tenant-2", "globex"));
    cookieStore.set(ACTIVE_TENANT_COOKIE, "tenant-three");

    expect(await getActiveTenant()).toBeNull();
  });

  it("returns null for a user with no memberships", async () => {
    expect(await getActiveTenant()).toBeNull();
  });

  it("consults the membership table on every call, not the cookie alone", async () => {
    // Memberships are revoked. A cookie cannot be withdrawn, and signing it
    // would only prove this server once issued it — which is why the check is
    // a read rather than a signature.
    membershipRows.push(row("tenant-1", "acme"));
    cookieStore.set(ACTIVE_TENANT_COOKIE, "tenant-1");

    expect(await getActiveTenant()).not.toBeNull();

    membershipRows.length = 0;

    expect(await getActiveTenant()).toBeNull();
  });
});

describe("getRequiredTenant", () => {
  it("returns the tenant when there is one", async () => {
    membershipRows.push(row("tenant-1", "acme"));

    expect((await getRequiredTenant()).tenantId).toBe("tenant-1");
  });

  it("sends a member of nothing to /forbidden, not to /login", async () => {
    // They are signed in and the route is real, so "you may not open this
    // workspace" is the accurate answer. A redirect to /login would loop:
    // the session is valid, so the login page bounces them straight back.
    await expect(getRequiredTenant()).rejects.toThrow(
      "NEXT_REDIRECT:/forbidden",
    );
  });
});
