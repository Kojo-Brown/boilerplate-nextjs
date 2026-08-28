/**
 * `defineAuthedAction` / `defineAuthedFormAction` — the factories in
 * `@/lib/actions/define-action` plus a session, mirroring the
 * `defineRoute` / `defineAuthedRoute` pair on the route side.
 *
 * Split into its own module for the same reason that pair is split: `auth()`
 * resolves through the Prisma adapter, so importing it is what drags the
 * Node-only graph into a module. Here the split buys something the route side
 * does not have as sharply — the handler's `user` is non-nullable. An action
 * that has to re-check what the guard already established is an action where
 * somebody eventually will not.
 *
 * ## Order of the three legs
 *
 * Origin, then session, then schema.
 *
 *   - Origin first because it is the cheapest and because a request that fails
 *     it should never have reached the process; there is no reason to open a
 *     database connection for it.
 *   - Session before schema so an anonymous caller learns "sign in", not a
 *     field-by-field description of the payload that would have worked. The
 *     shape of a mutation's input is not secret, but handing it to callers who
 *     have not authenticated is free reconnaissance.
 *
 * The session is threaded to the handler as an argument, through
 * `runHardenedAction`'s `prepare` step, and never through a variable the
 * factory closes over. That module-scope variable is the version of this that
 * looks tidier and is a cross-request auth-confusion bug — see the note on
 * `runHardenedAction`.
 */
import { auth } from "@/auth";
import { ActionError } from "@/lib/actions/result";
import {
  formDataToObject,
  runHardenedAction,
} from "@/lib/actions/define-action";
import type {
  FormAction,
  FormActionSpec,
  ActionSpec,
  ValueAction,
} from "@/lib/actions/define-action";
import type { ActionResult } from "@/lib/actions/result";
import type { Role, AuthedUser } from "@/lib/api/define-authed-route";
import type { z } from "zod";

export type { Role, AuthedUser };

/** What an anonymous caller sees unless the action overrides it. */
export const UNAUTHENTICATED_MESSAGE = "You must be signed in to do that.";

/** What a signed-in caller without the required role sees. */
export const FORBIDDEN_MESSAGE = "You do not have access to do that.";

interface AuthSpec {
  /**
   * Required role. Omitted means "any authenticated user"; `"ADMIN"` fails a
   * signed-in `USER` with `FORBIDDEN_MESSAGE`, which is a different answer from
   * the anonymous one and a caller is entitled to tell them apart.
   */
  role?: Role;
  /**
   * Overrides `UNAUTHENTICATED_MESSAGE`. Worth having because "You must be
   * signed in to create a post." is a better thing to put in a toast than the
   * generic sentence, and the wording is the only part of this the action
   * should get to decide.
   */
  unauthenticatedMessage?: string;
}

export type AuthedActionSpec<TRaw, TIn, TOut> = Omit<
  ActionSpec<TRaw, TIn, TOut>,
  "handler"
> &
  AuthSpec & {
    handler: (context: {
      input: TIn;
      user: AuthedUser;
    }) => Promise<TOut> | TOut;
  };

export type AuthedFormActionSpec<TIn, TOut> = Omit<
  FormActionSpec<TIn, TOut>,
  "handler"
> &
  AuthSpec & {
    handler: (context: {
      input: TIn;
      user: AuthedUser;
      formData: FormData;
    }) => Promise<TOut> | TOut;
  };

/**
 * Resolves the session and throws `ActionError` unless it satisfies `spec`.
 *
 * The id is checked rather than assumed, exactly as `defineAuthedRoute` does:
 * a session whose JWT predates the `id` callback deserialises to a user without
 * one, and every Prisma query in a handler would then filter on `undefined` —
 * which Prisma reads as "no filter", not "no rows". In a *mutation* that is the
 * difference between updating the caller's row and updating every row the rest
 * of the `where` matches.
 *
 * Throws rather than returning a result because it runs inside
 * `runHardenedAction`'s `try`, which turns an `ActionError` into the failure
 * half of `ActionResult`. Reaching the client as a thrown server fault is what
 * happens if this is ever hoisted out of that call.
 */
async function requireUser(spec: AuthSpec): Promise<AuthedUser> {
  const session = await auth();
  const user = session?.user;

  if (!user?.id) {
    throw new ActionError(
      spec.unauthenticatedMessage ?? UNAUTHENTICATED_MESSAGE,
    );
  }

  if (spec.role && user.role !== spec.role) {
    throw new ActionError(FORBIDDEN_MESSAGE);
  }

  return {
    id: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    image: user.image,
  };
}

/**
 * An authenticated action called with a value.
 *
 *   export const deletePostAction = defineAuthedAction({
 *     name: "deletePost",
 *     input: z.string().min(1),
 *     unauthenticatedMessage: "You must be signed in to delete a post.",
 *     handler: async ({ input, user }) => { … },
 *   });
 */
export function defineAuthedAction<TRaw, TIn, TOut>(
  spec: AuthedActionSpec<TRaw, TIn, TOut>,
): ValueAction<TRaw, TOut> {
  return async function authedAction(input: TRaw): Promise<ActionResult<TOut>> {
    return runHardenedAction(
      spec.name,
      // See `defineAction` for why the schema is widened here: the parameter
      // type is a compile-time convenience for call sites, and the value that
      // actually arrives came over the network.
      spec.input as z.ZodType<TIn, unknown>,
      input,
      () => requireUser(spec),
      (parsed, user) => spec.handler({ input: parsed, user }),
    );
  };
}

/** An authenticated action bound to a form through `useActionState`. */
export function defineAuthedFormAction<TIn, TOut>(
  spec: AuthedFormActionSpec<TIn, TOut>,
): FormAction<TOut> {
  return async function authedFormAction(
    _previous: ActionResult<TOut> | null,
    formData: FormData,
  ): Promise<ActionResult<TOut>> {
    return runHardenedAction(
      spec.name,
      spec.input,
      formDataToObject(formData),
      () => requireUser(spec),
      (parsed, user) => spec.handler({ input: parsed, user, formData }),
    );
  };
}
