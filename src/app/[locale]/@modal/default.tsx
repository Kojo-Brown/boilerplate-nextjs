/**
 * What the `@modal` slot renders when the URL is not a photo — which is every
 * route in this application except `/photos/[id]`.
 *
 * This file is not optional and its absence is not a compile error. A parallel
 * slot with no `default.tsx` throws at request time on any hard navigation to
 * a URL the slot does not match, because the router has no previous state to
 * fall back on: adding `@modal` to the root layout without this would 404 the
 * entire site on reload while leaving client-side navigation working, so it
 * would look fine in dev and break in production.
 *
 * Returning `null` is the whole implementation. The slot contributes nothing
 * to the markup, which is what keeps `/`, `/login`, `/register`, `/forbidden`
 * and `/blog` prerendering exactly as they did before the slot existed.
 */
export default function ModalDefault(): null {
  return null;
}
