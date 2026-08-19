/**
 * The error half of the route-handler contract.
 *
 * Every route handler in this repository answers with one of exactly two
 * shapes: the handler's own payload on success, or the envelope below on
 * failure. That is the whole point of having a layer here — before it, the two
 * hand-written routes each spelled their 401 differently (`{ error:
 * "Unauthorized" }`), nothing typed the failure case, and a client could not
 * tell a 401 from a 500 without reading the status by hand.
 *
 * The envelope is deliberately nested under `error` rather than flattened.
 * `{ error: "..." }` and a successful payload that happens to contain an
 * `error` field are indistinguishable; `{ error: { code, message } }` is not,
 * and `code` gives a client something stable to branch on that is not the
 * human-readable message.
 */
import { NextResponse } from "next/server";

/**
 * The status each code answers with. Codes rather than bare numbers because a
 * handler that throws `new ApiError("not_found", …)` says what happened; one
 * that throws a 404 says what the wire should look like, which is a decision
 * this module should be making, not the handler.
 */
export const API_ERROR_STATUS = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  /** Reserved for schema failures — see `ApiError.fromZod`. */
  unprocessable_entity: 422,
  too_many_requests: 429,
  internal_error: 500,
} as const satisfies Record<string, number>;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

/** Field-keyed messages, matching the `fieldErrors` half of Zod's flattened error. */
export type ApiFieldErrors = Record<string, string[]>;

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Present only for schema failures; absent on every other code. */
    fieldErrors?: ApiFieldErrors;
  };
}

/**
 * Thrown from a handler to answer with a specific status. Anything else that
 * escapes a handler is a bug, not a considered response, and `toApiErrorBody`
 * below turns it into an opaque 500 rather than leaking its message.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly fieldErrors: ApiFieldErrors | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    fieldErrors?: ApiFieldErrors,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }

  get status(): number {
    return API_ERROR_STATUS[this.code];
  }

  /**
   * A 422 carrying Zod's field errors.
   *
   * 422 rather than 400: the request was syntactically fine and the server
   * understood it, it just failed validation. Reserving 400 for malformed
   * input (unparseable JSON, say) keeps the two distinguishable on the wire.
   */
  static fromFieldErrors(
    message: string,
    fieldErrors: ApiFieldErrors,
  ): ApiError {
    return new ApiError("unprocessable_entity", message, fieldErrors);
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        // Spread rather than assign: `exactOptionalPropertyTypes` distinguishes
        // an absent `fieldErrors` from one explicitly set to `undefined`, and
        // the latter serialises to a key JSON consumers then have to handle.
        ...(this.fieldErrors && { fieldErrors: this.fieldErrors }),
      },
    };
  }

  toResponse(): NextResponse<ApiErrorBody> {
    return NextResponse.json(this.toBody(), { status: this.status });
  }
}

/**
 * Narrows an unknown throw to the envelope.
 *
 * An `ApiError` is a considered answer and is reported as thrown. Anything
 * else — a Prisma failure, a `TypeError`, a rejected fetch — is an internal
 * fault whose message may name a table, a file path or a connection string, so
 * it is answered with a fixed sentence and nothing from the original. The
 * original is still returned to the caller so `defineRoute` can log it
 * server-side, where it belongs.
 */
export function toApiError(thrown: unknown): ApiError {
  if (thrown instanceof ApiError) return thrown;
  return new ApiError("internal_error", "Internal server error");
}

/**
 * Whether a throw is the framework signalling control flow rather than failing.
 *
 * `redirect()`, `notFound()`, and — the one that actually bit — React's
 * prerender interrupt all communicate by throwing. Next says so in the message
 * itself: "React throws this special object to indicate where. It should not be
 * caught by your own try/catch."
 * (https://nextjs.org/docs/messages/ppr-caught-error)
 *
 * A catch-all in a route wrapper is exactly such a try/catch. Before this
 * guard, `pnpm build` logged four routes "failing" with a 500 during
 * prerendering: the wrapper had swallowed the interrupt, answered with an error
 * envelope, and denied Next the signal it uses to decide a route is dynamic.
 *
 * The test is the `digest` marker every one of these signals carries. Next
 * spells them as screaming snake case, optionally followed by `;`-separated
 * arguments:
 *
 *   NEXT_REDIRECT;replace;/login;307;   NEXT_HTTP_ERROR_FALLBACK;404
 *   NEXT_PRERENDER_INTERRUPTED          DYNAMIC_SERVER_USAGE
 *   HANGING_PROMISE_REJECTION
 *
 * The shape is matched rather than the five strings. A list was written first
 * and was already wrong: it covered the `NEXT_`-prefixed codes and
 * `DYNAMIC_SERVER_USAGE`, and the next build surfaced `HANGING_PROMISE_REJECTION`
 * — no prefix, thrown when `auth()` reads headers after a prerender completes.
 * A list of exact codes stops covering whatever Next adds next, and the failure
 * mode of missing one is precisely the invisible bug this guard exists to stop.
 *
 * The leading character must be a letter, which is what keeps this from
 * swallowing genuine application errors: React stamps errors it has already
 * handled with a `digest` too, but those are numeric hashes.
 */
const FRAMEWORK_DIGEST = /^[A-Z][A-Z0-9_]*(?:;|$)/;

export function isFrameworkSignal(thrown: unknown): boolean {
  if (typeof thrown !== "object" || thrown === null) return false;

  // React's postpone is a plain tagged object rather than an Error, so it has
  // no digest to match on.
  if (
    (thrown as { $$typeof?: unknown }).$$typeof === Symbol.for("react.postpone")
  ) {
    return true;
  }

  const { digest } = thrown as { digest?: unknown };
  return typeof digest === "string" && FRAMEWORK_DIGEST.test(digest);
}

/** Type guard for clients reading a response body of unknown shape. */
export function isApiErrorBody(body: unknown): body is ApiErrorBody {
  if (typeof body !== "object" || body === null || !("error" in body))
    return false;
  const { error } = body as { error: unknown };
  if (typeof error !== "object" || error === null) return false;
  return (
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    (error as { code: string }).code in API_ERROR_STATUS &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  );
}
