/**
 * `GET /api/preview?token=…` — redeem a signed preview token and open a draft
 * session scoped to the workspace that minted it. `DELETE /api/preview` — close
 * one.
 *
 * ## Two cookies, not one
 *
 * `draftMode().enable()` writes the framework's `__prerender_bypass`, which is
 * what makes the request a draft and carries nothing of ours. The workspace the
 * token names goes into a second, signed cookie — see `@/lib/preview/scope` for
 * why it has to exist and `@/lib/preview/draft` for how the blog reads it. Both
 * are written here and both are cleared by `DELETE`, because a draft session
 * whose scope is missing reads the published site and a scope whose session is
 * gone is a capability sitting in a jar doing nothing.
 *
 * ## Why this is not built on `defineRoute`
 *
 * Every other handler in this repository goes through `@/lib/api/define-route`,
 * whose contract is that a handler returns *data* and the wrapper turns it into
 * `NextResponse.json`. That is the right contract for an API, and it is the
 * wrong one here: this endpoint's success is a 307 to somewhere else, and a
 * body is the one thing it must not produce. Bending `defineRoute` into
 * returning arbitrary `Response`s to accommodate a single route would cost
 * every other route the guarantee that its payload has a type.
 *
 * What it does keep is the *failure* half. Anything that goes wrong here
 * answers with `ApiError`'s envelope, so a client sees the same
 * `{ error: { code, message } }` shape it would get from `/api/posts`. The
 * split is deliberate: the success shape is this route's own business, the
 * failure shape belongs to the API surface.
 *
 * ## Why there is no `connection()` call
 *
 * `draftMode().enable()` is itself a tracked dynamic access — it marks the
 * route dynamic on its own, which the build confirms by listing `/api/preview`
 * as `ƒ`. The `await connection()` that a prerendered route would need before
 * touching request data is therefore redundant here, and was left out after
 * checking that a build with `enable()` as the handler's very first statement
 * still succeeds.
 *
 * ## Runtime
 *
 * Nothing in this file's module graph is Node-only: token verification is Web
 * Crypto, and `draftMode()` is a framework primitive. `/api/preview` is
 * declared `portable: true` in `@/lib/api/runtimes` and
 * `scripts/assert-api-runtimes.ts` checks that against the build's dependency
 * trace, so an import of Prisma "just to check the post exists" would fail CI
 * rather than quietly pinning this route to Node.
 */
import { draftMode } from "next/headers";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ApiError } from "@/lib/api/errors";
import {
  PREVIEW_SCOPE_COOKIE,
  PREVIEW_SCOPE_COOKIE_ATTRIBUTES,
  signPreviewScope,
} from "@/lib/preview/scope";
import { verifyPreviewToken } from "@/lib/preview/token";
import type { PreviewTokenFailure } from "@/lib/preview/token";

/**
 * How each rejection is answered.
 *
 * A forged, truncated or off-origin token gets one indistinguishable 401: the
 * three failures differ only in what an attacker probing the endpoint would
 * learn from being told them apart. An *expired* token is the exception,
 * because the person holding one is overwhelmingly an author who left a tab
 * open, and "ask for a new link" is the only useful thing to say to them.
 */
const FAILURES: Record<PreviewTokenFailure, ApiError> = {
  malformed: new ApiError("unauthorized", "Invalid preview token."),
  "bad-signature": new ApiError("unauthorized", "Invalid preview token."),
  "unsafe-path": new ApiError("unauthorized", "Invalid preview token."),
  expired: new ApiError(
    "unauthorized",
    "This preview link has expired. Generate a new one from the dashboard.",
  ),
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return new ApiError(
      "bad_request",
      "A preview token is required.",
    ).toResponse();
  }

  const verification = await verifyPreviewToken(token);
  if (!verification.valid) {
    return FAILURES[verification.reason].toResponse();
  }

  // The scope cookie is minted *before* draft mode is enabled, because the one
  // ordering that must not happen is the reverse. `signPreviewScope` throws on a
  // tenant id it would not scope to — which a verified payload cannot carry,
  // since `parsePayload` applies the same check — and if it ever did, enabling
  // first would leave the caller in a draft session with no scope. Failing
  // before the mutation means a bad token changes nothing at all, which is what
  // `e2e/preview.spec.ts` asserts of a forged one.
  const scope = await signPreviewScope(verification.payload.tenantId);

  const draft = await draftMode();
  draft.enable();

  // The destination comes out of the verified payload, never out of the
  // request. See the note on `signPreviewToken` for why that distinction is the
  // point of signing the path at all.
  //
  // 307 rather than 302: the method must be preserved, and more practically a
  // 302 here is the kind of thing a CDN will cache and then serve to the next
  // person without the `Set-Cookie` that makes it mean anything.
  const response = NextResponse.redirect(
    new URL(verification.payload.path, request.nextUrl.origin),
    307,
  );

  // Set on the response rather than through `cookies()`. Both reach the browser,
  // and this one is visible in the object the handler returns — which matters
  // here because the *other* cookie on this response is written by the framework
  // into a mutable store it merges in afterwards, and a reader comparing the two
  // should not have to know that to see that two cookies are being set. It is
  // also what lets `route.test.ts` assert the value without a framework double.
  response.cookies.set({
    name: PREVIEW_SCOPE_COOKIE,
    value: scope,
    ...PREVIEW_SCOPE_COOKIE_ATTRIBUTES,
  });

  return response;
}

/**
 * Closes the draft session.
 *
 * `DELETE` rather than `GET`, and unauthenticated on purpose. It clears one
 * cookie in the caller's own browser and can do nothing else, so there is
 * nothing here to protect: the worst a forged call achieves is ending a preview
 * for the person who made it. Requiring a token to *stop* previewing would mean
 * an author whose link had expired could not get out of draft mode.
 *
 * The banner in `@/components/preview/preview-banner` does not use this — it
 * posts to `exitPreviewAction`, which can also redirect. This exists for the
 * CMS side of the integration, which has a session to end and no page to
 * return to.
 */
export async function DELETE(): Promise<NextResponse<{ previewing: false }>> {
  const draft = await draftMode();
  draft.disable();

  const response = NextResponse.json({ previewing: false } as const);

  // Cleared with the same attributes it was set with, not just by name. A
  // browser matches a deletion against name, path and domain, so a `delete`
  // that forgets `path: "/"` leaves the cookie in place on every path but the
  // one the request happened to arrive on — and the next draft session would
  // then inherit this one's workspace.
  response.cookies.set({
    name: PREVIEW_SCOPE_COOKIE,
    value: "",
    ...PREVIEW_SCOPE_COOKIE_ATTRIBUTES,
    maxAge: 0,
  });

  return response;
}
