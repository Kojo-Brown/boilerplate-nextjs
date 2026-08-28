/**
 * The unauthenticated half of the Server Action contract: origin check, Zod
 * parse, error envelope.
 *
 * ## Why a factory rather than three helpers
 *
 * Because "call these three helpers at the top of every action" is a
 * convention, and this repository has already written down what happens to
 * conventions in a `"use server"` module. `src/actions/blog.ts` carries the
 * post-mortem: an exported `revalidatePost(id)` with a comment asserting it was
 * "called by the post mutations, not from the browser", which was reachable
 * from the browser by anyone and called by nothing. Every export of a
 * `"use server"` module is a public POST endpoint. The three legs below are the
 * entire difference between that being fine and that being a hole, and they
 * were, before this module, remembered by hand in six actions and forgotten in
 * two:
 *
 *   - `getPresignedUploadUrlAction` declared `input: PresignedUrlInput` and
 *     parsed nothing. `filename.split(".").pop()` went straight into an S3 key,
 *     so a `filename` of `"x.png/../../../etc"` wrote outside the caller's
 *     prefix, and a `filename` that was not a string at all was a 500.
 *   - `deletePostAction(postId: string)` passed its argument to
 *     `prisma.post.findUnique` untouched; a non-string threw out of the action
 *     rather than returning a failure the UI could show.
 *
 * A factory makes the three legs structural instead of remembered, and
 * `scripts/assert-action-hardening.ts` fails CI on an export of a
 * `"use server"` module that is not built by one.
 *
 * ## Three factories, not one
 *
 * They differ in the *signature React requires at the call site*, which is not
 * something a flag can change:
 *
 *   `defineAction`           `(input) => Promise<ActionResult<T>>`
 *                            Called from a client component with a value.
 *   `defineFormAction`       `(previous, formData) => Promise<ActionResult<T>>`
 *                            The `useActionState` signature.
 *   `defineNavigationAction` `(formData?) => Promise<void>`
 *                            A `<form action={…}>` whose handler redirects and
 *                            has no result to report.
 *
 * `@/lib/actions/define-authed-action` adds the session leg to the first two.
 */
import { z } from "zod";
import { isFrameworkSignal } from "@/lib/api/errors";
import { assertSameOrigin } from "@/lib/actions/origin";
import { ActionError, err, ok } from "@/lib/actions/result";
import type { ActionResult } from "@/lib/actions/result";

/**
 * What the caller sees when a handler throws something that is not an
 * `ActionError`.
 *
 * Fixed, for the reason `toApiError` gives on the route side: the original may
 * name a table, a column, a file path or a connection string. It is logged
 * server-side and replaced here.
 */
export const UNEXPECTED_ERROR_MESSAGE =
  "Something went wrong. Please try again.";

/** What the caller sees when the input fails its schema. */
export const INVALID_INPUT_MESSAGE = "Please check your input.";

export interface ActionSpec<TRaw, TIn, TOut> {
  /**
   * Identifies the action in server logs. Not shown to callers.
   *
   * Required rather than derived, because the name a bundler leaves on a
   * `"use server"` export is not something to build an operator's only record
   * of a fault on.
   */
  name: string;
  /**
   * The input schema. Not optional — "Zod input parsing on every action" is the
   * property this file exists to make true, and an optional schema is one
   * every future action may quietly decline. An action that takes nothing
   * declares `z.object({})` and says so.
   *
   * Typed `ZodType<TIn, TRaw>` rather than `ZodType<TIn, unknown>` (which is
   * what `defineRoute` uses for a JSON body) so the *returned* action is typed
   * against the schema's input at its call sites. A route's body arrives over
   * the wire from an unknown client; a Server Action is called from this
   * repository's own components, and letting the compiler check that call is
   * worth having. The parse is still what makes it true at runtime.
   */
  input: z.ZodType<TIn, TRaw>;
  handler: (context: { input: TIn }) => Promise<TOut> | TOut;
}

/** The value-argument action `defineAction` returns. */
export type ValueAction<TRaw, TOut> = (
  input: TRaw,
) => Promise<ActionResult<TOut>>;

/** The `useActionState` action `defineFormAction` returns. */
export type FormAction<TOut> = (
  previous: ActionResult<TOut> | null,
  formData: FormData,
) => Promise<ActionResult<TOut>>;

/** The `<form action={…}>` action `defineNavigationAction` returns. */
export type NavigationAction = (formData?: FormData) => Promise<void>;

/**
 * Turns a `FormData` into the object a schema sees.
 *
 * `Object.fromEntries` is the one-liner and it is lossy: it keeps the *last*
 * value of a repeated key, so a checkbox group of three arrives as one string
 * and the schema validates a value that is not what was submitted. Repeated
 * keys become arrays here instead.
 *
 * The remaining ambiguity is inherent to the format and worth stating: a group
 * with exactly one box ticked is indistinguishable from a scalar field, so it
 * arrives as a scalar. A schema that wants an array either way should say
 * `z.union([z.string(), z.array(z.string())]).transform(v => [v].flat())`. The
 * raw `FormData` is also handed to the handler for the cases where that is not
 * enough.
 */
export function formDataToObject(
  formData: FormData,
): Record<string, FormDataEntryValue | FormDataEntryValue[]> {
  const object: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};

  for (const key of new Set(formData.keys())) {
    const values = formData.getAll(key);
    // `getAll` never returns an empty array for a key `keys()` yielded, so
    // indexing [0] here is total.
    object[key] =
      values.length > 1 ? values : (values[0] as FormDataEntryValue);
  }

  return object;
}

/**
 * The sentence that goes in `ActionResult["error"]` when a schema rejects.
 *
 * A single issue is reported as itself. Not a flourish: `ActionResult` has two
 * channels, and they are read by different UI. `fieldErrors` renders under the
 * input it names — which is what the login and register forms do — while
 * `error` is the one line that reaches a toast, and every non-form caller
 * (`ImageUpload`, `PreviewButton`) shows only that. Collapsing a lone
 * "File exceeds the 5 MB size limit." into "Please check your input." would
 * take a message the user can act on and replace it with one they cannot,
 * everywhere there is no field to hang the detail on.
 *
 * Two or more issues do get the generic sentence: concatenating them produces a
 * sentence about nothing in particular, and a form with several bad fields is
 * exactly the case where `fieldErrors` is already saying it better.
 */
function summarise(error: z.ZodError): string {
  const [only] = error.issues;
  return error.issues.length === 1 && only
    ? only.message
    : INVALID_INPUT_MESSAGE;
}

/** Zod's issues, keyed by field, in the shape `ActionResult` carries. */
export function toFieldErrors(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    // A whole-schema failure — a cross-field refinement, or a non-object schema
    // rejecting outright — has an empty path and no field to blame. It lands on
    // `_` rather than being dropped, because a failure that reports no reason
    // at all is the one a caller cannot act on.
    const key = issue.path.length > 0 ? issue.path.join(".") : "_";
    (fieldErrors[key] ??= []).push(issue.message);
  }

  return fieldErrors;
}

/**
 * The shared body of the result-returning factories: check the origin, run
 * whatever guard the caller supplies, parse the input, run the handler, and
 * turn anything thrown into a result.
 *
 * `prepare` is where `defineAuthedAction` puts the session read. It runs after
 * the origin check and *before* the schema, so an unauthenticated caller gets
 * "you must be signed in" rather than a field-by-field description of the shape
 * they should have sent — and what it returns is passed to `run` as an
 * argument.
 *
 * That last part is load-bearing rather than stylistic. The obvious alternative
 * — resolve the user into a variable the handler closes over — is a correctness
 * bug in a server: the factory runs once at module scope, so that variable is
 * shared by every concurrent invocation, and the `await` between writing it and
 * reading it is exactly the window in which a second request overwrites it.
 * Two users mutating posts at the same moment would be enough. Nothing that
 * varies per request may live anywhere but the call stack.
 *
 * Exported because `@/lib/actions/define-authed-action` is the other half of
 * this contract and needs the same `try`; it is not part of the public surface
 * an action author uses.
 */
export async function runHardenedAction<TIn, TOut, TPrepared>(
  name: string,
  schema: z.ZodType<TIn, unknown>,
  raw: unknown,
  prepare: () => Promise<TPrepared>,
  run: (input: TIn, prepared: TPrepared) => Promise<TOut> | TOut,
): Promise<ActionResult<TOut>> {
  try {
    await assertSameOrigin();

    const prepared = await prepare();

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return err(summarise(parsed.error), toFieldErrors(parsed.error));
    }

    return ok(await run(parsed.data, prepared));
  } catch (thrown) {
    // Control flow, not failure — `redirect()` and `notFound()` inside a
    // handler communicate by throwing, and swallowing one here would turn a
    // navigation into a silent no-op. See `isFrameworkSignal`.
    if (isFrameworkSignal(thrown)) throw thrown;

    if (thrown instanceof ActionError) return thrown.toResult();

    // The only record of the original. `UNEXPECTED_ERROR_MESSAGE` replaces it
    // on the way out, so if it is not logged here it is gone.
    console.error(`[action] ${name} failed:`, thrown);
    return err(UNEXPECTED_ERROR_MESSAGE);
  }
}

/**
 * An action called with a value from a client component.
 *
 *   export const createDraftAction = defineAction({
 *     name: "createDraft",
 *     input: z.object({ title: z.string().min(1) }),
 *     handler: ({ input }) => createDraft(input.title),
 *   });
 */
export function defineAction<TRaw, TIn, TOut>(
  spec: ActionSpec<TRaw, TIn, TOut>,
): ValueAction<TRaw, TOut> {
  return async function action(input: TRaw): Promise<ActionResult<TOut>> {
    return runHardenedAction(
      spec.name,
      // The declared parameter type is the schema's *input*; the value that
      // actually arrives came over the network and is `unknown`. Widening here
      // is what keeps `safeParse` the thing that establishes the type, rather
      // than the signature asserting it.
      spec.input as z.ZodType<TIn, unknown>,
      input,
      noGuard,
      (parsed) => spec.handler({ input: parsed }),
    );
  };
}

/** The `prepare` step of an action with nothing to establish before parsing. */
async function noGuard(): Promise<undefined> {
  return undefined;
}

export interface FormActionSpec<TIn, TOut> {
  name: string;
  /** Parses the object `formDataToObject` builds, not the `FormData` itself. */
  input: z.ZodType<TIn, unknown>;
  handler: (context: {
    input: TIn;
    /** The submission verbatim, for the multi-value cases the object flattens. */
    formData: FormData;
  }) => Promise<TOut> | TOut;
}

/**
 * An action bound to a form through `useActionState`.
 *
 * The `previous` argument is ignored rather than passed to the handler: an
 * action that branches on the last result is one whose behaviour depends on
 * client-supplied state, since `previous` is whatever React sent back.
 */
export function defineFormAction<TIn, TOut>(
  spec: FormActionSpec<TIn, TOut>,
): FormAction<TOut> {
  return async function formAction(
    _previous: ActionResult<TOut> | null,
    formData: FormData,
  ): Promise<ActionResult<TOut>> {
    return runHardenedAction(
      spec.name,
      spec.input,
      formDataToObject(formData),
      noGuard,
      (parsed) => spec.handler({ input: parsed, formData }),
    );
  };
}

export interface NavigationActionSpec<TIn> {
  name: string;
  input: z.ZodType<TIn, unknown>;
  /** Expected to redirect. A handler that returns normally simply ends the POST. */
  handler: (context: { input: TIn }) => Promise<void> | void;
}

/**
 * An action posted by a plain `<form action={…}>` that navigates rather than
 * reporting a result — sign in, sign out, leave preview mode.
 *
 * Returns `Promise<void>` because that is what React's `form action` prop
 * accepts, which also means there is nowhere to put a failure. So the
 * conventions here differ from the other two factories, and both differences
 * are deliberate:
 *
 *   - A schema failure **throws**. There is no result channel, and the
 *     alternative — proceeding on unvalidated input — is the thing this file
 *     exists to prevent. An action that must tolerate bad input gives its
 *     schema a `.catch(fallback)`, which is a decision written in the schema
 *     rather than a silent one; `exitPreviewAction` does exactly that, because
 *     an unusable `returnTo` must still get the reader out of draft mode.
 *   - Everything thrown reaches the segment's `error.tsx`. `redirect()` passes
 *     through untouched, as it must.
 */
export function defineNavigationAction<TIn>(
  spec: NavigationActionSpec<TIn>,
): NavigationAction {
  return async function navigationAction(formData?: FormData): Promise<void> {
    await assertSameOrigin();

    // `{}` rather than `undefined` when React invokes the action with no
    // arguments (a `<form action>` always passes FormData, but an action called
    // from a transition may not), so a `z.object({})` schema accepts both.
    const raw = formData ? formDataToObject(formData) : {};

    const parsed = spec.input.safeParse(raw);
    if (!parsed.success) {
      throw new ActionError(
        summarise(parsed.error),
        toFieldErrors(parsed.error),
      );
    }

    await spec.handler({ input: parsed.data });
  };
}
