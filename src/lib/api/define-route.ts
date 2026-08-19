/**
 * `defineRoute` — the typed half of the route-handler contract.
 *
 * A raw App Router handler is `(Request) => Response`. Everything that makes it
 * an *API* — parsing the query string, rejecting a bad body, turning a thrown
 * error into a status, keeping the success and failure shapes in a type a
 * client can import — is left to the author, and was duplicated (differently)
 * in each of the two handlers this repository started with. This wraps that up
 * once:
 *
 *   export const GET = defineRoute({
 *     query: z.object({ q: z.string().optional() }),
 *     handler: ({ query }) => searchPhotos(query.q),
 *   });
 *
 * The handler returns *data*, not a `Response`. That is the load-bearing
 * decision here: it makes the success payload a value with a type, so
 * `RouteData<typeof GET>` can hand the client the exact shape the server
 * returns and a change on one side fails typecheck on the other.
 *
 * ## Runtime
 *
 * This module deliberately imports nothing outside the Web Fetch API and
 * `next/server`, so it is usable from a handler on any runtime. Authentication
 * needs Prisma and is therefore Node-only; it lives in `defineAuthedRoute`
 * (`./define-authed-route.ts`) so that importing it — rather than a flag passed
 * to this function — is what pulls the Node-only graph into a route. See
 * `docs/route-handlers.md` for why that boundary is structural rather than
 * configured.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { ApiError, isFrameworkSignal, toApiError } from "@/lib/api/errors";
import type { ApiErrorBody } from "@/lib/api/errors";

/**
 * The context Next passes as the second argument. `params` is typed `unknown`
 * on purpose: the generated route validator requires the exported handler to
 * accept `{ params: Promise<ParamMap[Route]> }` for its own route, and only a
 * parameter this wide is assignable for *every* route. The concrete shape comes
 * back from the `params` schema below, which is a runtime check rather than a
 * cast — so a dynamic segment that gets renamed fails as a 422 instead of
 * reading `undefined` off an object TypeScript was told to trust.
 */
export interface RouteHandlerContext {
  params: Promise<unknown>;
}

export interface RouteContext<TQuery, TParams, TBody> {
  request: NextRequest;
  /** Parsed `?query=string`, or `undefined` when the route declares no schema. */
  query: TQuery;
  /** Parsed dynamic segments, or `undefined` when the route declares no schema. */
  params: TParams;
  /** Parsed JSON body, or `undefined` when the route declares no schema. */
  body: TBody;
}

/**
 * Schemas are typed as `z.ZodType<Out, In>` rather than `z.ZodObject`, so a
 * route may declare a refined or transformed schema and still get its *output*
 * type in the handler.
 */
export interface RouteSpec<TQuery, TParams, TBody, TData> {
  query?: z.ZodType<TQuery, unknown>;
  params?: z.ZodType<TParams, unknown>;
  body?: z.ZodType<TBody, unknown>;
  /** Success status. 200 unless a route has a reason to differ (201, 202, 204). */
  status?: number;
  handler: (
    context: RouteContext<TQuery, TParams, TBody>,
  ) => Promise<TData> | TData;
}

/**
 * The exported handler's type. `Response` rather than `NextResponse<T>`: the
 * union of the payload and the error envelope is what actually goes on the
 * wire, and `RouteData` below is the honest way to recover the success half.
 */
export type RouteHandler<TData> = ((
  request: NextRequest,
  context?: RouteHandlerContext,
) => Promise<NextResponse<TData | ApiErrorBody>>) & {
  /**
   * Phantom carrier for the success payload type. Never present at runtime —
   * it exists so `RouteData<typeof GET>` can name the shape a client will
   * receive without the route having to export a second, hand-maintained type
   * that drifts from the handler.
   */
  readonly __data?: TData;
};

/** The success payload of a handler built by `defineRoute`. */
export type RouteData<THandler> =
  THandler extends RouteHandler<infer TData> ? TData : never;

/**
 * Parses one input against its schema, or throws a 422 naming the field.
 *
 * `where` prefixes the field keys (`query.limit`, `body.title`) because a
 * client that sends both a bad query and a bad body otherwise gets two
 * identically-keyed error maps and cannot tell which input to fix.
 */
async function parseOrThrow<T>(
  schema: z.ZodType<T, unknown> | undefined,
  // A thunk, not a value. Reading `nextUrl.searchParams` is a *dynamic access*:
  // doing it eagerly made even `/api/health`, which declares no query schema
  // and reads nothing, bail out of prerendering. A route now touches only the
  // inputs it actually declared.
  getValue: () => unknown | Promise<unknown>,
  where: "query" | "params" | "body",
): Promise<T> {
  if (!schema) return undefined as T;

  const result = schema.safeParse(await getValue());
  if (result.success) return result.data;

  // Built from `issues` rather than `z.flattenError`, for two reasons: the
  // flattened form collapses a nested path to its first segment, and its
  // `fieldErrors` is typed from the schema's output — which is opaque here,
  // since the parameter is a `ZodType<T, unknown>` and not a known object.
  //
  // A whole-schema failure (a cross-field refinement, or a non-object schema)
  // has an empty path and no field to key on; those land on `where` itself,
  // because a 422 carrying an empty map tells the client nothing.
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key =
      issue.path.length > 0 ? `${where}.${issue.path.join(".")}` : where;
    (fieldErrors[key] ??= []).push(issue.message);
  }

  throw ApiError.fromFieldErrors(`Invalid ${where}`, fieldErrors);
}

/** `?a=1&a=2` collapses to `"2"`; a route wanting both declares `z.array()` via `getAll`. */
function searchParamsToObject(
  searchParams: URLSearchParams,
): Record<string, string> {
  return Object.fromEntries(searchParams);
}

async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    // A body that is not JSON at all is a 400, not a 422: there is nothing to
    // validate and no field to blame.
    throw new ApiError("bad_request", "Request body must be valid JSON");
  }
}

export function defineRoute<
  TData,
  TQuery = undefined,
  TParams = undefined,
  TBody = undefined,
>(spec: RouteSpec<TQuery, TParams, TBody, TData>): RouteHandler<TData> {
  return async function routeHandler(
    request: NextRequest,
    context?: RouteHandlerContext,
  ): Promise<NextResponse<TData | ApiErrorBody>> {
    try {
      const query = await parseOrThrow(
        spec.query,
        () => searchParamsToObject(request.nextUrl.searchParams),
        "query",
      );
      const params = await parseOrThrow(
        spec.params,
        () => context?.params ?? {},
        "params",
      );
      const body = await parseOrThrow(
        spec.body,
        () => readJsonBody(request),
        "body",
      );

      const data = await spec.handler({ request, query, params, body });

      return NextResponse.json<TData>(data, { status: spec.status ?? 200 });
    } catch (thrown) {
      // Control flow, not failure. Must leave this frame untouched — see
      // `isFrameworkSignal`.
      if (isFrameworkSignal(thrown)) throw thrown;

      const error = toApiError(thrown);

      // An `ApiError` is a considered answer and needs no log line. Anything
      // else is a fault whose only record is this one — `toApiError` has
      // already replaced its message with a fixed sentence for the client, so
      // if it is not logged here it is gone.
      if (error !== thrown) {
        console.error(
          `[api] ${request.method} ${request.nextUrl.pathname} failed:`,
          thrown,
        );
      }

      return error.toResponse();
    }
  };
}
