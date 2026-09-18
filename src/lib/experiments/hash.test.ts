import { describe, it, expect } from "vitest";
import { BUCKET_SPACE, bucketSeed, hashToBucket } from "@/lib/experiments/hash";

describe("hashToBucket — determinism", () => {
  it("returns the same bucket for the same seed", () => {
    expect(hashToBucket("visitor-a")).toBe(hashToBucket("visitor-a"));
  });

  it("returns a bucket inside the space", () => {
    for (let index = 0; index < 1_000; index += 1) {
      const bucket = hashToBucket(`visitor-${index}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(BUCKET_SPACE);
    }
  });

  it("returns an integer", () => {
    expect(Number.isInteger(hashToBucket("visitor-a"))).toBe(true);
  });

  it("honours a custom space", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(hashToBucket(`visitor-${index}`, 4)).toBeLessThan(4);
    }
  });

  it("rejects a space that is not a positive integer", () => {
    expect(() => hashToBucket("a", 0)).toThrow(RangeError);
    expect(() => hashToBucket("a", -1)).toThrow(RangeError);
    expect(() => hashToBucket("a", 1.5)).toThrow(RangeError);
  });

  /**
   * The regression guard for the whole feature. If this file's algorithm ever
   * changes, every visitor already in an experiment is re-bucketed — half of
   * them into the other arm — and nothing else in the suite would notice,
   * because every other test here asks only for internal consistency.
   *
   * The values are the current implementation's output, recorded rather than
   * derived. Changing them deliberately means accepting that every live
   * experiment restarts.
   */
  it("produces the recorded buckets for known seeds", () => {
    expect(hashToBucket("")).toBe(8_923);
    expect(hashToBucket("visitor-1")).toBe(5_787);
    expect(hashToBucket("visitor-2")).toBe(3_829);
    expect(hashToBucket("00000000-0000-4000-8000-000000000000")).toBe(8_355);
  });
});

describe("hashToBucket — distribution", () => {
  /**
   * The soft requirement, checked rather than assumed.
   *
   * A 50/50 split that is really 60/40 does not fail anything: the experiment
   * runs, the dashboard fills in, and the arms are compared at sizes nobody
   * declared. 20,000 sequential ids through a two-way split should land within
   * a percentage point of even — sequential ids being the least uniform input
   * this is likely to see, and the one FNV-1a alone handles badly.
   */
  it("splits sequential ids evenly in two", () => {
    const total = 20_000;
    let low = 0;
    for (let index = 0; index < total; index += 1) {
      if (hashToBucket(`visitor-${index}`) < BUCKET_SPACE / 2) low += 1;
    }
    expect(Math.abs(low / total - 0.5)).toBeLessThan(0.01);
  });

  it("splits UUID-shaped ids evenly in two", () => {
    const total = 20_000;
    let low = 0;
    for (let index = 0; index < total; index += 1) {
      const id = `0000${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
      if (hashToBucket(id) < BUCKET_SPACE / 2) low += 1;
    }
    expect(Math.abs(low / total - 0.5)).toBeLessThan(0.01);
  });

  it("keeps every decile within 10% of its expected share", () => {
    const total = 50_000;
    const deciles = new Array<number>(10).fill(0);
    for (let index = 0; index < total; index += 1) {
      const decile = Math.floor(
        hashToBucket(`visitor-${index}`) / (BUCKET_SPACE / 10),
      );
      deciles[decile] = (deciles[decile] ?? 0) + 1;
    }
    for (const count of deciles) {
      expect(count).toBeGreaterThan(total / 10 - total / 100);
      expect(count).toBeLessThan(total / 10 + total / 100);
    }
  });
});

describe("bucketSeed", () => {
  it("separates the parts unambiguously", () => {
    expect(bucketSeed("ab", "c", "d")).not.toBe(bucketSeed("a", "bc", "d"));
  });

  it("gives one visitor independent buckets in two experiments", () => {
    // Not merely "different": the point is that a visitor in the treatment of
    // one experiment is not thereby in the treatment of the other. Over a
    // population, the two splits should be uncorrelated.
    const total = 20_000;
    let both = 0;
    for (let index = 0; index < total; index += 1) {
      const id = `visitor-${index}`;
      const first = hashToBucket(bucketSeed(id, "one", "s")) < BUCKET_SPACE / 2;
      const second =
        hashToBucket(bucketSeed(id, "two", "s")) < BUCKET_SPACE / 2;
      if (first && second) both += 1;
    }
    // Independent 50/50 splits put a quarter of the population in both.
    expect(Math.abs(both / total - 0.25)).toBeLessThan(0.015);
  });

  it("re-splits the population when the salt changes", () => {
    const total = 5_000;
    let moved = 0;
    for (let index = 0; index < total; index += 1) {
      const id = `visitor-${index}`;
      const before =
        hashToBucket(bucketSeed(id, "exp", "a")) < BUCKET_SPACE / 2;
      const after = hashToBucket(bucketSeed(id, "exp", "b")) < BUCKET_SPACE / 2;
      if (before !== after) moved += 1;
    }
    // Two independent splits disagree about half the time.
    expect(Math.abs(moved / total - 0.5)).toBeLessThan(0.03);
  });
});
