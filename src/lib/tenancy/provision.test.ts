import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tenancy/client", () => ({
  unscopedPrisma: { tenant: {}, membership: {} },
}));

import { provisionPersonalTenant, provisionTenant } from "./provision";

/** Prisma's unique-constraint violation, which is the only error the retry may swallow. */
function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });
}

/**
 * `ProvisioningClient` is Prisma's model delegates, which carry a great deal
 * more surface than these two calls. The cast is to the two methods actually
 * reached, and it is the test's own narrowing rather than a claim about the
 * production type — `provisionTenant`'s parameter stays the real one, so a
 * call it makes that is not stubbed here fails loudly.
 */
function client() {
  return {
    tenant: { create: vi.fn() },
    membership: { create: vi.fn() },
  };
}

function asProvisioningClient(
  stub: ReturnType<typeof client>,
): Parameters<typeof provisionTenant>[0] {
  return stub as unknown as Parameters<typeof provisionTenant>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("provisionTenant", () => {
  it("creates the tenant and the owner's membership", async () => {
    const db = client();
    db.tenant.create.mockResolvedValue({ id: "tenant-1", slug: "acme" });
    db.membership.create.mockResolvedValue({});

    const result = await provisionTenant(asProvisioningClient(db), {
      name: "Acme",
      ownerId: "user-1",
    });

    expect(result).toEqual({ tenantId: "tenant-1", slug: "acme" });
    expect(db.tenant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: "Acme", slug: "acme" } }),
    );
    expect(db.membership.create).toHaveBeenCalledWith({
      data: { tenantId: "tenant-1", userId: "user-1", role: "OWNER" },
    });
  });

  it("takes an explicit slug over one derived from the name", async () => {
    const db = client();
    db.tenant.create.mockResolvedValue({ id: "t", slug: "chosen" });

    await provisionTenant(asProvisioningClient(db), {
      name: "Acme",
      ownerId: "user-1",
      slug: "chosen",
    });

    expect(db.tenant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: "Acme", slug: "chosen" } }),
    );
  });

  it("suffixes and retries on a slug collision", async () => {
    // Two people called their workspace "Acme". That is expected, and it is
    // resolved by suffixing rather than by failing.
    const db = client();
    db.tenant.create
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValue({ id: "tenant-2", slug: "acme-1a2b" });

    const result = await provisionTenant(asProvisioningClient(db), {
      name: "Acme",
      ownerId: "user-2",
    });

    expect(db.tenant.create).toHaveBeenCalledTimes(2);
    expect(result.slug).toBe("acme-1a2b");

    const [, second] = db.tenant.create.mock.calls;
    expect((second?.[0] as { data: { slug: string } }).data.slug).toMatch(
      /^acme-[0-9a-f]{4}$/,
    );
  });

  it("detects the collision with the index, not with a preceding read", async () => {
    // A `findUnique` that says "free" and a `create` that assumes it are two
    // statements, and two registrations racing for `acme` both pass the read.
    const db = client();
    db.tenant.create.mockResolvedValue({ id: "t", slug: "acme" });

    await provisionTenant(asProvisioningClient(db), {
      name: "Acme",
      ownerId: "user-1",
    });

    expect(db.tenant).not.toHaveProperty("findUnique.mock");
    expect(db.tenant.create).toHaveBeenCalledTimes(1);
  });

  it("rethrows anything that is not a unique violation", async () => {
    // Retrying a dead connection eight times turns one error into eight and
    // reports the last of them.
    const db = client();
    db.tenant.create.mockRejectedValue(new Error("connection refused"));

    await expect(
      provisionTenant(asProvisioningClient(db), {
        name: "Acme",
        ownerId: "user-1",
      }),
    ).rejects.toThrow("connection refused");
    expect(db.tenant.create).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of attempts", async () => {
    // The exit condition is a database constraint, so the loop must not be
    // unbounded — a unique index that is somehow always violated would
    // otherwise hang the request.
    const db = client();
    db.tenant.create.mockRejectedValue(uniqueViolation());

    await expect(
      provisionTenant(asProvisioningClient(db), {
        name: "Acme",
        ownerId: "user-1",
      }),
    ).rejects.toThrow(/Could not find a free slug/);
    expect(db.tenant.create).toHaveBeenCalledTimes(8);
  });

  it("falls back to an id-derived slug for a name that does not reduce to one", async () => {
    // `slugify("日本語")` is the empty string, which is not a slug. That is
    // ordinary rather than an error.
    const db = client();
    db.tenant.create.mockResolvedValue({ id: "t", slug: "w-abc" });

    await provisionTenant(asProvisioningClient(db), {
      name: "日本語",
      ownerId: "cuid-abcdefghij",
    });

    const [first] = db.tenant.create.mock.calls;
    expect((first?.[0] as { data: { slug: string } }).data.slug).toMatch(
      /^w-[a-z0-9]+$/,
    );
  });

  it("falls back when the name reduces to a reserved word", async () => {
    const db = client();
    db.tenant.create.mockResolvedValue({ id: "t", slug: "w-abc" });

    await provisionTenant(asProvisioningClient(db), {
      name: "Admin",
      ownerId: "cuid-abcdefghij",
    });

    const [first] = db.tenant.create.mock.calls;
    expect((first?.[0] as { data: { slug: string } }).data.slug).not.toBe(
      "admin",
    );
  });

  it("does not create a membership when the tenant insert failed", async () => {
    // A membership pointing at a tenant that does not exist is a foreign key
    // violation at best; the ordering is what makes it impossible.
    const db = client();
    db.tenant.create.mockRejectedValue(new Error("nope"));

    await expect(
      provisionTenant(asProvisioningClient(db), {
        name: "Acme",
        ownerId: "user-1",
      }),
    ).rejects.toThrow();
    expect(db.membership.create).not.toHaveBeenCalled();
  });
});

describe("provisionPersonalTenant", () => {
  it("names the workspace after its owner", async () => {
    const db = client();
    db.tenant.create.mockResolvedValue({ id: "t", slug: "adas-workspace" });

    await provisionPersonalTenant(asProvisioningClient(db), {
      id: "user-1",
      name: "Ada",
      email: "ada@example.test",
    });

    expect(db.tenant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: "Ada's workspace", slug: "adas-workspace" },
      }),
    );
  });

  it("makes the owner an OWNER", async () => {
    const db = client();
    db.tenant.create.mockResolvedValue({ id: "t", slug: "s" });

    await provisionPersonalTenant(asProvisioningClient(db), {
      id: "user-1",
      name: "Ada",
      email: "ada@example.test",
    });

    expect(db.membership.create).toHaveBeenCalledWith({
      data: { tenantId: "t", userId: "user-1", role: "OWNER" },
    });
  });

  it("has a name for an account with none", async () => {
    // OAuth providers do not all supply one, and neither does a credentials
    // sign-up that left the field blank.
    const db = client();
    db.tenant.create.mockResolvedValue({ id: "t", slug: "my-workspace" });

    await provisionPersonalTenant(asProvisioningClient(db), {
      id: "user-1",
      name: null,
      email: "ada@example.test",
    });

    expect(db.tenant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: "My workspace", slug: "my-workspace" },
      }),
    );
  });

  it("treats a whitespace-only name as no name", async () => {
    const db = client();
    db.tenant.create.mockResolvedValue({ id: "t", slug: "my-workspace" });

    await provisionPersonalTenant(asProvisioningClient(db), {
      id: "user-1",
      name: "   ",
      email: "ada@example.test",
    });

    expect(db.tenant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: "My workspace", slug: "my-workspace" },
      }),
    );
  });
});
