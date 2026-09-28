import { describe, it, expect } from "vitest";
import { scrypt, randomBytes, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  parsePasswordHash,
  PASSWORD_HASH_POLICY,
  SALT_BYTES,
  KEY_BYTES,
  type ScryptParameters,
} from "./password";

const scryptAsync = promisify(scrypt);

/** `scrypt` with options and nothing else supplied — Node's defaults, probed. */
function rawScrypt(options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt("x", "salt", 32, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * Most cases here are about a string's shape, not about work, so they hash at
 * the cheapest parameters this module accepts. The handful that are genuinely
 * about `PASSWORD_HASH_POLICY` say so by using it.
 */
const CHEAP: ScryptParameters = { ln: 1, r: 1, p: 1 };

/**
 * The previous implementation, reproduced exactly.
 *
 * Copied rather than imported because the point is to produce a string this
 * module no longer knows how to write — a row already sitting in somebody's
 * `users` table — and check that it still opens. Its two details are both
 * load-bearing: the salt reaches `scrypt` as a hex *string*, so the bytes
 * hashed are that string's own, and the key is 64 bytes rather than 32.
 */
async function legacyHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${derived.toString("hex")}.${salt}`;
}

describe("hashPassword", () => {
  it("records its own cost parameters in the hash", async () => {
    const hash = await hashPassword("secret123", CHEAP);
    expect(hash).toMatch(/^\$scrypt\$ln=1,r=1,p=1\$[^$]+\$[^$]+$/);
  });

  it("defaults to the current policy", async () => {
    const hash = await hashPassword("secret123");
    const { ln, r, p } = PASSWORD_HASH_POLICY;
    expect(hash.split("$")[2]).toBe(`ln=${ln},r=${r},p=${p}`);
  });

  it("produces different hashes for the same password", async () => {
    const [h1, h2] = await Promise.all([
      hashPassword("same-password", CHEAP),
      hashPassword("same-password", CHEAP),
    ]);
    expect(h1).not.toBe(h2);
  });

  it("refuses parameters whose working set exceeds the ceiling", async () => {
    // 128 * 2^24 * 8 is 16 GiB. Inside the per-field bound on `ln` and well
    // outside the product bound, which is the pair the ceiling exists to catch.
    await expect(hashPassword("x", { ln: 24, r: 8, p: 1 })).rejects.toThrow(
      RangeError,
    );
  });

  it("raises the cost without help from maxmem, which Node defaults to 32 MiB", async () => {
    // This is the assertion the old module could not have passed. Node refuses
    // `N = 2^15` outright unless `maxmem` is raised with it, so a format that
    // records its parameters is necessary but not sufficient — the derivation
    // has to compute the limit from them too.
    await expect(rawScrypt({ N: 2 ** 15, r: 8, p: 1 })).rejects.toThrow(
      /memory limit exceeded/,
    );

    const hash = await hashPassword("x", { ln: 15, r: 8, p: 1 });
    await expect(verifyPassword("x", hash)).resolves.toBe(true);
  });
});

describe("verifyPassword", () => {
  it("returns true for a correct password", async () => {
    const hash = await hashPassword("my-secure-password", CHEAP);
    await expect(verifyPassword("my-secure-password", hash)).resolves.toBe(
      true,
    );
  });

  it("returns false for an incorrect password", async () => {
    const hash = await hashPassword("my-secure-password", CHEAP);
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });

  it("derives at the hash's parameters and not at the current policy", async () => {
    // The hash below is at parameters no current call would produce. If verify
    // read `PASSWORD_HASH_POLICY` instead of the stored fields, this is the
    // case that fails — and in production it fails as "nobody can sign in".
    const hash = await hashPassword("pw", { ln: 2, r: 3, p: 1 });
    expect(hash).toContain("ln=2,r=3,p=1");
    expect(needsRehash(hash)).toBe(true);
    await expect(verifyPassword("pw", hash)).resolves.toBe(true);
  });

  it("verifies a hash written by the previous parameterless format", async () => {
    const legacy = await legacyHash("my-secure-password");
    await expect(verifyPassword("my-secure-password", legacy)).resolves.toBe(
      true,
    );
    await expect(verifyPassword("wrong-password", legacy)).resolves.toBe(false);
  });

  it("returns false for a hash without a dot separator", async () => {
    await expect(verifyPassword("any", "nodotinthishash")).resolves.toBe(false);
  });

  it("returns false for an empty hash", async () => {
    await expect(verifyPassword("any", "")).resolves.toBe(false);
  });

  it("returns false rather than allocating for a hash demanding gigabytes", async () => {
    // `ln=24, r=32` asks for 64 GiB. A stored hash is an input, and the
    // parameters in it are an allocation size inside an unauthenticated POST.
    const bomb = `$scrypt$ln=24,r=32,p=1$${"c2FsdHNhbHRzYWx0c2FsdA"}$${"a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5"}`;
    await expect(verifyPassword("any", bomb)).resolves.toBe(false);
  });

  it("returns false for base64 fields that are not canonical", async () => {
    const hash = await hashPassword("pw", CHEAP);
    const [, , params, salt, key] = hash.split("$");
    // `Buffer.from` skips characters outside the alphabet rather than failing,
    // so without a round-trip check this decodes to the same salt and verifies.
    const smuggled = `$scrypt$${params}$${salt}!!$${key}`;
    await expect(verifyPassword("pw", smuggled)).resolves.toBe(false);
  });
});

describe("parsePasswordHash", () => {
  it("reads back the parameters, salt and key it wrote", async () => {
    const hash = await hashPassword("pw", CHEAP);
    const parsed = parsePasswordHash(hash);

    expect(parsed).not.toBeNull();
    expect(parsed?.params).toEqual(CHEAP);
    expect(parsed?.salt).toHaveLength(SALT_BYTES);
    expect(parsed?.key).toHaveLength(KEY_BYTES);
    expect(parsed?.legacy).toBe(false);
  });

  it("reports a legacy hash as Node's defaults, which is what produced it", async () => {
    const parsed = parsePasswordHash(await legacyHash("pw"));
    expect(parsed?.legacy).toBe(true);
    expect(parsed?.params).toEqual({ ln: 14, r: 8, p: 1 });
    expect(parsed?.key).toHaveLength(64);
  });

  it("returns null for a hash naming another algorithm", () => {
    expect(
      parsePasswordHash("$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA"),
    ).toBe(null);
  });

  it("returns null for a truncated PHC string", () => {
    expect(
      parsePasswordHash("$scrypt$ln=16,r=8,p=2$c2FsdHNhbHRzYWx0c2FsdA"),
    ).toBe(null);
  });
});

describe("needsRehash", () => {
  it("is false for a hash at the current policy", async () => {
    expect(needsRehash(await hashPassword("pw"))).toBe(false);
  });

  it("is true for every hash in the previous format", async () => {
    expect(needsRehash(await legacyHash("pw"))).toBe(true);
  });

  it("is true when any single parameter is below policy", async () => {
    const { ln, r, p } = PASSWORD_HASH_POLICY;
    const below: ScryptParameters[] = [
      { ln: ln - 1, r, p },
      { ln, r: r - 1, p },
      { ln, r, p: p - 1 },
    ];

    for (const params of below) {
      expect(needsRehash(await hashPassword("pw", params))).toBe(true);
    }
  });

  it("does not downgrade a hash that is above policy", async () => {
    // A row written by a deployment ahead of this one, mid-rollout. Rehashing
    // it would lower its cost automatically for everyone who signs in.
    const stronger = await hashPassword("pw", {
      ...PASSWORD_HASH_POLICY,
      p: PASSWORD_HASH_POLICY.p + 1,
    });
    expect(needsRehash(stronger)).toBe(false);
  });

  it("refuses to score memory hardness away against iteration count", async () => {
    // The case a scalar work factor gets wrong: trivial N, enormous p. scrypt
    // without memory is PBKDF2 with extra steps, so this must not read as
    // current however the numbers multiply out.
    const cheapButSlow = await hashPassword("pw", { ln: 1, r: 1, p: 16 });
    expect(needsRehash(cheapButSlow)).toBe(true);
  });

  it("is true for a string it cannot read at all", () => {
    expect(needsRehash("")).toBe(true);
    expect(needsRehash("!!!!")).toBe(true);
  });
});
