import { describe, it, expect } from "vitest";
import {
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
  signWebhookPayload,
  verifyWebhookSignature,
} from "./signature";

/**
 * The signer and the verifier are both real here. A mocked signer would let
 * every case below pass against a verifier that checked nothing, which is the
 * single failure this file exists to rule out.
 *
 * `env` is not mocked either: `src/test/setup.ts` supplies `NEXTAUTH_SECRET`,
 * and the fallback derivation is part of what is under test — a webhook secret
 * that silently resolved to `undefined` would still produce a self-consistent
 * signer, and every "valid signature verifies" test would still pass.
 */
const BODY = JSON.stringify({ event: "post.published", postId: "post-1" });

function at(secondsFromNow: number): Date {
  return new Date(Date.now() + secondsFromNow * 1000);
}

describe("signWebhookPayload", () => {
  it("produces a header the verifier accepts", async () => {
    const header = await signWebhookPayload(BODY);

    await expect(verifyWebhookSignature(header, BODY)).resolves.toMatchObject({
      valid: true,
    });
  });

  it("emits the documented t=…,v1=… shape", async () => {
    const header = await signWebhookPayload(BODY, {
      now: new Date(1_774_483_200_000),
    });

    // Pinned because it is the shape `docs/on-demand-revalidation.md` tells a
    // CMS integrator to produce. Changing it is a breaking change for every
    // configured sender, so it should fail here rather than in production.
    expect(header).toMatch(/^t=1774483200,v1=[0-9a-f]{64}$/);
  });

  it("reports the instant it was signed", async () => {
    const now = at(-30);
    const header = await signWebhookPayload(BODY, { now });

    const result = await verifyWebhookSignature(header, BODY);
    expect(result.valid && result.signedAt.getTime()).toBe(
      Math.floor(now.getTime() / 1000) * 1000,
    );
  });
});

describe("verifyWebhookSignature", () => {
  it("rejects a body that was changed after signing", async () => {
    const header = await signWebhookPayload(BODY);

    const tampered = JSON.stringify({
      event: "post.published",
      postId: "post-2",
    });

    await expect(verifyWebhookSignature(header, tampered)).resolves.toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("rejects a body that differs only in whitespace", async () => {
    // The reason the route verifies raw bytes rather than a re-serialised
    // object: these two parse to the same value, and only one of them was
    // signed. A verifier built on `JSON.stringify(parsed)` accepts both.
    const header = await signWebhookPayload(BODY);
    const reformatted = JSON.stringify(JSON.parse(BODY), null, 2);

    expect(JSON.parse(reformatted)).toEqual(JSON.parse(BODY));
    await expect(
      verifyWebhookSignature(header, reformatted),
    ).resolves.toMatchObject({ valid: false });
  });

  it("rejects a timestamp moved forward to refresh a captured request", async () => {
    // The replay attempt the scheme is shaped against: capture a valid
    // delivery, rewrite `t` to now, resend. The timestamp is inside the signed
    // material, so the rewrite invalidates the signature it was trying to
    // preserve — and this fails as `bad-signature`, not as `outside-tolerance`.
    const stale = await signWebhookPayload(BODY, {
      now: at(-SIGNATURE_TOLERANCE_SECONDS - 60),
    });
    const signature = stale.split(",")[1];
    const refreshed = `t=${Math.floor(Date.now() / 1000)},${signature}`;

    await expect(verifyWebhookSignature(refreshed, BODY)).resolves.toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("rejects a signature older than the tolerance window", async () => {
    const header = await signWebhookPayload(BODY, {
      now: at(-SIGNATURE_TOLERANCE_SECONDS - 1),
    });

    await expect(verifyWebhookSignature(header, BODY)).resolves.toEqual({
      valid: false,
      reason: "outside-tolerance",
    });
  });

  it("accepts a signature at the edge of the window", async () => {
    const header = await signWebhookPayload(BODY, {
      now: at(-SIGNATURE_TOLERANCE_SECONDS),
    });

    await expect(verifyWebhookSignature(header, BODY)).resolves.toMatchObject({
      valid: true,
    });
  });

  it("rejects a future-dated signature beyond the window", async () => {
    // Applied symmetrically on purpose: a sender that can date a signature
    // arbitrarily far ahead can mint one that stays valid indefinitely.
    const header = await signWebhookPayload(BODY, {
      now: at(SIGNATURE_TOLERANCE_SECONDS + 1),
    });

    await expect(verifyWebhookSignature(header, BODY)).resolves.toEqual({
      valid: false,
      reason: "outside-tolerance",
    });
  });

  it("tolerates a modestly fast clock on the sender", async () => {
    const header = await signWebhookPayload(BODY, { now: at(30) });

    await expect(verifyWebhookSignature(header, BODY)).resolves.toMatchObject({
      valid: true,
    });
  });

  it("reports a missing header separately from a bad one", async () => {
    await expect(verifyWebhookSignature(null, BODY)).resolves.toEqual({
      valid: false,
      reason: "missing",
    });
    await expect(verifyWebhookSignature("", BODY)).resolves.toEqual({
      valid: false,
      reason: "missing",
    });
  });

  it.each([
    ["no fields at all", "nonsense"],
    ["a missing signature", "t=1774483200"],
    ["a missing timestamp", "v1=abcdef"],
    ["an empty signature", "t=1774483200,v1="],
    ["a non-numeric timestamp", "t=yesterday,v1=abcdef"],
    ["an exponent-shaped timestamp", "t=17e8,v1=abcdef"],
    ["a trailing-garbage timestamp", "t=1774483200abc,v1=abcdef"],
    ["a non-hex signature", "t=1774483200,v1=zzzz"],
    ["an odd-length signature", "t=1774483200,v1=abc"],
  ])("reports %s as malformed", async (_name, header) => {
    await expect(verifyWebhookSignature(header, BODY)).resolves.toEqual({
      valid: false,
      reason: "malformed",
    });
  });

  it("ignores extra fields, so a scheme rollover is not a rejection", async () => {
    const header = await signWebhookPayload(BODY);

    await expect(
      verifyWebhookSignature(`${header},v2=deadbeef`, BODY),
    ).resolves.toMatchObject({ valid: true });
  });

  it("reads fields in any order", async () => {
    const [timestamp, signature] = (await signWebhookPayload(BODY)).split(",");

    await expect(
      verifyWebhookSignature(`${signature},${timestamp}`, BODY),
    ).resolves.toMatchObject({ valid: true });
  });

  it("takes the first value of a duplicated field", async () => {
    // A sender cannot append a second `v1=` to smuggle a value past a verifier
    // that happens to read the other one.
    const header = await signWebhookPayload(BODY);

    await expect(
      verifyWebhookSignature(`${header},v1=${"0".repeat(64)}`, BODY),
    ).resolves.toMatchObject({ valid: true });
    await expect(
      verifyWebhookSignature(`t=1,${header}`, BODY),
    ).resolves.toMatchObject({ valid: false });
  });

  it("verifies an empty body, which is what a bodyless POST signs", async () => {
    const header = await signWebhookPayload("");

    await expect(verifyWebhookSignature(header, "")).resolves.toMatchObject({
      valid: true,
    });
    await expect(verifyWebhookSignature(header, "{}")).resolves.toMatchObject({
      valid: false,
    });
  });

  it("cannot be satisfied by a signature over a different split of the same characters", async () => {
    // Why the separator exists. Without it, `t=1` over body `"23"` and `t=12`
    // over body `"3"` would hash identical material.
    const header = await signWebhookPayload("23", {
      now: new Date(1_000),
    });
    const moved = header.replace("t=1,", "t=12,");

    await expect(verifyWebhookSignature(moved, "3")).resolves.toMatchObject({
      valid: false,
    });
  });
});

describe("SIGNATURE_HEADER", () => {
  it("is lowercase, because header lookups here are case-sensitive", () => {
    expect(SIGNATURE_HEADER).toBe(SIGNATURE_HEADER.toLowerCase());
  });
});
