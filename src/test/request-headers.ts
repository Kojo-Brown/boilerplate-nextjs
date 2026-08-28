/**
 * Control over the request headers a Server Action sees under test.
 *
 * `src/test/setup.ts` mocks `next/headers` to return a same-origin request, so
 * an action test exercises the ordinary path without saying anything. This is
 * for the tests that need the other paths: a cross-origin post, a request with
 * no `Origin` at all, a proxied request whose `x-forwarded-host` is the public
 * name.
 *
 * Kept out of `setup.ts` because `vi.mock` factories are hoisted above every
 * import and cannot close over anything — so the constant lives in `setup.ts`
 * and the helpers, which run at test time, live here.
 */
import { vi } from "vitest";
import { headers } from "next/headers";
import { SAME_ORIGIN_HEADERS } from "@/test/setup";

export { SAME_ORIGIN_HEADERS };

/** Replaces the headers the next `headers()` call resolves to. */
export function setRequestHeaders(init: Record<string, string>): void {
  vi.mocked(headers).mockResolvedValue(
    new Headers(init) as unknown as Awaited<ReturnType<typeof headers>>,
  );
}

/** Restores the same-origin default `setup.ts` installs. */
export function resetRequestHeaders(): void {
  setRequestHeaders(SAME_ORIGIN_HEADERS);
}
