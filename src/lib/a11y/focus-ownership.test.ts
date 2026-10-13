import { beforeEach, describe, expect, it } from "vitest";
import {
  claimFocusOwnership,
  isFocusOwned,
  resetFocusOwnershipForTests,
} from "./focus-ownership";

describe("focus ownership", () => {
  beforeEach(resetFocusOwnershipForTests);

  it("is unowned by default", () => {
    expect(isFocusOwned()).toBe(false);
  });

  it("is owned while a claim is held", () => {
    const release = claimFocusOwnership();
    expect(isFocusOwned()).toBe(true);
    release();
    expect(isFocusOwned()).toBe(false);
  });

  it("stays owned until the last of several claims is released", () => {
    // A confirmation dialog opened from inside the photo modal: releasing the
    // inner one must not hand focus back to the router while the outer
    // overlay is still up.
    const outer = claimFocusOwnership();
    const inner = claimFocusOwnership();

    inner();
    expect(isFocusOwned()).toBe(true);

    outer();
    expect(isFocusOwned()).toBe(false);
  });

  it("ignores a release called twice", () => {
    // React invokes an effect's cleanup twice under Strict Mode's
    // double-invocation. A release that decremented each time would take the
    // count negative and leave the claim permanently off for every later
    // dialog.
    const outer = claimFocusOwnership();
    const inner = claimFocusOwnership();

    inner();
    inner();

    expect(isFocusOwned()).toBe(true);
    outer();
    expect(isFocusOwned()).toBe(false);
  });
});
