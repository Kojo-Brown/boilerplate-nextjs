/**
 * The success/failure envelope every Server Action answers with, and the throw
 * that produces the failure half.
 *
 * Moved here from `src/lib/actions.ts` when the hardening factories arrived, so
 * that the action layer is one directory (`@/lib/actions/*`) the way the route
 * layer is one directory (`@/lib/api/*`). A `src/lib/actions.ts` file sitting
 * beside a `src/lib/actions/` directory resolves fine and reads like a mistake.
 */

export type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string; fieldErrors?: Record<string, string[]> };

export function ok<T>(data: T): ActionResult<T> {
  return { success: true, data };
}

export function err(
  error: string,
  fieldErrors?: Record<string, string[]>,
): ActionResult<never> {
  // Spread rather than assign: `exactOptionalPropertyTypes` distinguishes an
  // absent `fieldErrors` from one explicitly set to `undefined`.
  return { success: false, error, ...(fieldErrors && { fieldErrors }) };
}

/**
 * Thrown from an action handler to answer with a specific failure.
 *
 * The same split `ApiError` makes for route handlers, and for the same reason:
 * a handler that throws this has *decided* something, and its message is meant
 * for the caller. Anything else that escapes a handler is a fault — a Prisma
 * error naming a table, a `TypeError` naming a file path — and the factories in
 * this directory replace it with a fixed sentence and log the original
 * server-side, where a message that names internals belongs.
 *
 * There is no status code here, deliberately. A Server Action is not an HTTP
 * endpoint a client branches on; it is a function returning `ActionResult`, and
 * the only thing the caller can do with a failure is show it.
 */
export class ActionError extends Error {
  readonly fieldErrors: Record<string, string[]> | undefined;

  constructor(message: string, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = "ActionError";
    this.fieldErrors = fieldErrors;
  }

  toResult(): ActionResult<never> {
    return err(this.message, this.fieldErrors);
  }
}
