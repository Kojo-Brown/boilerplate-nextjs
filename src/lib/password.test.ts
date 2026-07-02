import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("hashPassword", () => {
  it("produces a hash with dot-separated hex.salt format", async () => {
    const hash = await hashPassword("secret123");
    expect(hash).toMatch(/^[0-9a-f]+\.[0-9a-f]+$/);
  });

  it("produces different hashes for the same password", async () => {
    const [h1, h2] = await Promise.all([
      hashPassword("same-password"),
      hashPassword("same-password"),
    ]);
    expect(h1).not.toBe(h2);
  });
});

describe("verifyPassword", () => {
  it("returns true for a correct password", async () => {
    const hash = await hashPassword("my-secure-password");
    await expect(verifyPassword("my-secure-password", hash)).resolves.toBe(true);
  });

  it("returns false for an incorrect password", async () => {
    const hash = await hashPassword("my-secure-password");
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });

  it("returns false for a hash without a dot separator", async () => {
    await expect(verifyPassword("any", "nodotinthishash")).resolves.toBe(false);
  });

  it("returns false for an empty hash", async () => {
    await expect(verifyPassword("any", "")).resolves.toBe(false);
  });
});
