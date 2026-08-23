/**
 * `GET /api/preview?token=…` — redeem a signed preview token and open a draft
 * session. `DELETE /api/preview` — close one.
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

  const draft = await draftMode();
  draft.enable();

  // The destination comes out of the verified payload, never out of the
  // request. See the note on `signPreviewToken` for why that distinction is the
  // point of signing the path at all.
  //
  // 307 rather than 302: the method must be preserved, and more practically a
  // 302 here is the kind of thing a CDN will cache and then serve to the next
  // person without the `Set-Cookie` that makes it mean anything.
  return NextResponse.redirect(
    new URL(verification.payload.path, request.nextUrl.origin),
    307,
  );
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

  return NextResponse.json({ previewing: false } as const);
}
