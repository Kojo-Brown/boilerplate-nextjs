/**
 * `POST /api/outbox` — drains the outbox.
 *
 * ## Why the relay is an endpoint rather than a worker process
 *
 * Because of where Next's cache lives. An event's effect here is
 * `revalidateTag`, and that is a call into the *running server's* cache
 * handler: a standalone Node worker importing `@/lib/outbox/relay` and calling
 * it from a cron container would claim rows, dispatch them, mark them
 * processed, and drop nothing — Next's invalidation APIs need a request context
 * to be in. So the relay has to run inside the application, and the only way in
 * from outside is a request.
 *
 * That also decides the dispatch context: `"route-handler"`, which routes to
 * `revalidateFromWebhook`. `invalidate()` — the Server Action path — would
 * throw here on every row (E872), and a unit test with `next/cache` mocked
 * would not notice. See `@/lib/outbox/dispatch`.
 *
 * ## Who may call it
 *
 * The same HMAC scheme as `/api/revalidate`, header and secret included. Not
 * laziness: the two endpoints have exactly the same authority. Everything this
 * one can do is drop cache tags for events the application itself recorded, so
 * a caller who can sign for `/api/revalidate` — where they choose the event —
 * can already cause a superset of these effects. Minting a second secret would
 * suggest a separation that does not exist.
 *
 * What it must not become is unauthenticated. The relay does real work per
 * request, and an open endpoint is a way to make the server do it in a loop.
 *
 * ## Why the response is a report
 *
 * A cron whose only feedback is `200 OK` cannot tell "nothing was owed" from
 * "the relay has been dead-lettering every event for a week". The body names
 * what was claimed, what was dispatched, which tags that dropped, and every
 * failure with its reason — so a scheduler's delivery log is evidence rather
 * than a heartbeat.
 *
 * ## Runtime
 *
 * Node, and `portable: false` in `@/lib/api/runtimes`: this route reads and
 * writes the outbox table through Prisma. Unlike `/api/revalidate`, which is
 * deliberately kept free of the database, there is no version of this endpoint
 * that does not need it.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api/errors";
import type { ApiErrorBody } from "@/lib/api/errors";
import { dispatchOutboxEvent } from "@/lib/outbox/dispatch";
import { relayOutbox, RELAY_BATCH_SIZE } from "@/lib/outbox/relay";
import type { RelayReport } from "@/lib/outbox/relay";
import { prismaOutboxStore, sweepProcessedEvents } from "@/lib/outbox/store";
import {
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
  verifyWebhookSignature,
} from "@/lib/webhooks/signature";
import type { SignatureFailure } from "@/lib/webhooks/signature";

/**
 * How long a processed row is kept before `sweep` removes it.
 *
 * A day, which is long enough to answer "did that publish actually invalidate
 * anything?" the morning after and short enough that the table does not become
 * a second copy of the post history.
 */
export const PROCESSED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The same mapping `/api/revalidate` uses, for the same reasons. */
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

/**
 * The request body.
 *
 * Both fields are optional and an empty object is valid, because the caller is
 * a scheduler: the useful default is "do the normal thing", and requiring a
 * payload would mean every cron entry carries a JSON literal it never varies.
 * The body still has to be present and parse — the signature covers bytes, and
 * "no body" is not a thing that can be signed meaningfully.
 */
const relayRequestSchema = z.object({
  /**
   * How many rows to claim. Bounded above because the batch is dispatched
   * inside one request, and a caller asking for fifty thousand is asking for a
   * request that times out halfway through with its rows claimed.
   */
  limit: z.number().int().positive().max(500).optional(),
  /** Also delete processed rows past their retention window. */
  sweep: z.boolean().optional(),
});

export interface OutboxRelayPayload extends RelayReport {
  /** Processed rows deleted by this call. Absent unless `sweep` was asked for. */
  swept?: number;
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<OutboxRelayPayload | ApiErrorBody>> {
  // The raw bytes, read once and before anything parses them: the signature
  // covers these, and a check against a re-serialised object is not a check.
  const body = await request.text();

  const verification = await verifyWebhookSignature(
    request.headers.get(SIGNATURE_HEADER),
    body,
  );
  if (!verification.valid) {
    return FAILURES[verification.reason].toResponse();
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    return new ApiError(
      "bad_request",
      "Request body must be valid JSON.",
    ).toResponse();
  }

  const parsed = relayRequestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return ApiError.fromFieldErrors("Invalid relay request", {
      body: [
        `Expected an object with an optional numeric \`limit\` (1-500) and an optional boolean \`sweep\`; ` +
          `\`{}\` claims up to ${RELAY_BATCH_SIZE}.`,
      ],
    }).toResponse();
  }

  const report = await relayOutbox({
    store: prismaOutboxStore,
    // A route handler, so `revalidateTag` — see the note on the runtime above.
    dispatch: (event) => dispatchOutboxEvent(event, "route-handler"),
    // Spread rather than `limit: parsed.data.limit`: under
    // `exactOptionalPropertyTypes` an explicit `undefined` is not the same as an
    // absent property, and the absent one is what takes the default.
    ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
  });

  const payload: OutboxRelayPayload = { ...report };

  if (parsed.data.sweep) {
    payload.swept = await sweepProcessedEvents(
      new Date(Date.now() - PROCESSED_RETENTION_MS),
    );
  }

  return NextResponse.json<OutboxRelayPayload>(payload);
}
