/**
 * A claim on the keyboard focus, for the one case where two components both
 * have a correct reason to move it in the same commit.
 *
 * Navigating from `/photos` to `/photos/<id>` renders the intercepting route
 * into the `@modal` slot. That is simultaneously a route change — so
 * `<RouteFocus>` wants to focus `<main>` — and a dialog opening, so
 * `<PhotoModal>` wants to focus the dialog. Both are right about their own
 * half, and without something arbitrating, which one wins is decided by effect
 * ordering in the React tree: the dialog's effect runs before the root
 * layout's sibling, so focus lands on the dialog and is then taken back out of
 * it, to a landmark behind an `aria-modal` overlay.
 *
 * The alternatives were worse. Sniffing the DOM for `[aria-modal="true"]`
 * makes the root layout depend on the markup of every dialog in the
 * application and silently stops working when one renders late. Listing the
 * modal routes in the root layout duplicates the routing table in the one
 * place that should not need to know it. A claim is explicit, is held by the
 * component that actually performs the competing focus move, and reads the
 * same way from either side.
 *
 * Module-level rather than context: `<RouteFocus>` is a sibling of the
 * `@modal` slot, not an ancestor of it, so there is no provider position from
 * which a context could be read by both. The registry is per-document state
 * about the document's focus, which is what a module scope is.
 */

/**
 * A count, not a boolean. Two dialogs can be mounted at once — a confirmation
 * opened from inside the photo modal — and releasing the inner one must not
 * hand the focus back to the router while the outer one is still up.
 */
let claims = 0;

/**
 * Claim the focus for a component that manages it itself.
 *
 * Returns the release function, shaped for an effect cleanup:
 *
 * ```ts
 * React.useEffect(() => claimFocusOwnership(), []);
 * ```
 *
 * The release is idempotent. React can call an effect cleanup more than once
 * in development with Strict Mode's double-invocation, and a release that
 * decremented twice would leave the count negative and the claim permanently
 * off.
 */
export function claimFocusOwnership(): () => void {
  claims += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims -= 1;
  };
}

/** Whether any component currently manages the focus itself. */
export function isFocusOwned(): boolean {
  return claims > 0;
}

/**
 * Drop every claim.
 *
 * For tests only: module state outlives a test file's cases, and one that
 * unmounts a dialog without cleanup would otherwise leave the next case
 * asserting against a claim it never made.
 */
export function resetFocusOwnershipForTests(): void {
  claims = 0;
}
