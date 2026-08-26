/**
 * `POST /api/revalidate` — the on-demand ISR trigger, for callers that are not
 * browsers.
 *
 * The blog's pages are prerendered (`generateStaticParams` on `/blog/[slug]`)
 * and refill on a timer (`cacheLife` in `@/lib/cache/blog`). Everything inside
 * this application that changes a post already tells the cache so, through
 * `invalidate()` in a Server Action. This is the other half: a CMS, a
 * migration, a bulk import or a restored backup writes to the database without
 * going through a Server Action, and something has to be able to say so from
 * outside.
 *
 * ## Why this is not built on `defineRoute`
 *
 * The same reason as `/api/preview`, and one more that is specific to
 * signatures. `defineRoute` parses the body for you — and the signature covers
 * the *bytes*, not the parsed object, so a handler that receives an already
 * parsed body has no way to check it. See `@/lib/webhooks/signature` for why
 * re-serialising the parsed value is not equivalent.
 *
 * The failure half of the contract is kept: everything that goes wrong here
 * answers with `ApiError`'s `{ error: { code, message } }` envelope, so a CMS's
 * delivery log shows the same shape it would get from `/api/posts`.
 *
 * ## Why the response says which tags were dropped
 *
 * A webhook that answers `{ ok: true }` is indistinguishable from one that
 * verified a signature, understood nothing, and did nothing — which is the
 * exact failure a misconfigured event name produces. Returning the tags makes
 * the delivery log in the CMS evidence of an effect rather than of a round
 * trip.
 *
 * ## Runtime
 *
 * Nothing in this module's graph is Node-only: the signature is Web Crypto, the
 * policy is a pure function, and `revalidateTag` is a framework primitive. The
 * route is declared `portable: true` in `@/lib/api/runtimes`, and
 * `scripts/assert-api-runtimes.ts` checks that against the build's dependency
 * trace — so an import of Prisma "just to check the post exists" fails CI
 * rather than quietly pinning this route to Node.
 *
 * There is deliberately no such existence check. Verifying the post would make
 * the endpoint's answer depend on replication lag between the CMS's write and
 * ours, and the safe outcome of a revalidation for a post that does not exist
 * is a dropped tag that nothing was holding.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ApiError } from "@/lib/api/errors";
import type { ApiErrorBody } from "@/lib/api/errors";
import { revalidateFromWebhook } from "@/lib/cache/invalidation";
import {
  REVALIDATE_EVENTS,
  mutationFor,
  revalidateEventSchema,
} from "@/lib/webhooks/revalidate-events";
import {
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
  verifyWebhookSignature,
} from "@/lib/webhooks/signature";
import type { SignatureFailure } from "@/lib/webhooks/signature";

/**
 * How each signature rejection is answered.
 *
 * Three of the four get one indistinguishable 401: a missing header, a
 * malformed one and a forged one differ only in what someone probing the
 * endpoint would learn from being told them apart. A timestamp outside the
 * tolerance window is the exception, because the person hitting it is
 * overwhelmingly an integrator whose sender's clock is wrong, and it leaks
 * nothing — the timestamp is in the request they just sent.
 */
const FAILURES: Record<SignatureFailure, ApiError> = {
  missing: new ApiError("unauthorized", "Invalid webhook signature."),
  malformed: new ApiError("unauthorized", "Invalid webhook signature."),
  "bad-signature": new ApiError("unauthorized", "Invalid webhook signature."),
  "outside-tolerance": new ApiError(
    "unauthorized",
    `Signature timestamp is outside the ${SIGNATURE_TOLERANCE_SECONDS}-second tolerance window. ` +
      "Check the clock on the sending system.",
  ),
};

export interface RevalidatePayload {
  revalidated: boolean;
  /** The tags this call dropped. Empty for an event that invalidates nothing. */
  tags: readonly string[];
  /** The event as understood, echoed so a delivery log records what was acted on. */
  event: string;
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<RevalidatePayload | ApiErrorBody>> {
  // The raw bytes, before anything parses them. Read first and exactly once:
  // the body is a stream, so `request.json()` after this would fail, and a
  // signature checked against anything but these bytes is not a check.
  const body = await request.text();

  const verification = await verifyWebhookSignature(
    request.headers.get(SIGNATURE_HEADER),
    body,
  );
  if (!verification.valid) {
    return FAILURES[verification.reason].toResponse();
  }

  // Only now is the body worth parsing. Ordering it this way means an
  // unauthenticated caller cannot get the endpoint to do work, and cannot tell
  // a malformed payload from a well-formed one by the answer it gets.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    return new ApiError(
      "bad_request",
      "Request body must be valid JSON.",
    ).toResponse();
  }

  const event = revalidateEventSchema.safeParse(parsedJson);
  if (!event.success) {
    return ApiError.fromFieldErrors("Invalid webhook payload", {
      // Keyed on `body` rather than on the failing field: a discriminated-union
      // mismatch reports against the discriminator, and "expected one of these
      // six" is the message that actually helps someone whose CMS is sending
      // `post.publish`.
      body: [`Expected one of: ${REVALIDATE_EVENTS.join(", ")}.`],
    }).toResponse();
  }

  const mutation = mutationFor(event.data);
  const tags = mutation === null ? [] : revalidateFromWebhook(mutation);

  return NextResponse.json<RevalidatePayload>({
    // `false` for an event that dropped nothing — a `ping`, or a change to a
    // post no cached read was holding. Saying `true` there would make the field
    // a synonym for "the request was accepted", which the status code already
    // is.
    revalidated: tags.length > 0,
    tags,
    event: event.data.event,
  });
}
