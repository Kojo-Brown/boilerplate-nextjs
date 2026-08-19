/**
 * `defineAuthedRoute` — `defineRoute` plus a session, for Node-only routes.
 *
 * ## Why this is a separate module and not an `auth: true` flag
 *
 * `auth()` resolves through the Prisma adapter, and Prisma is a Node-only
 * dependency. Had authentication been an option on `defineRoute`, every route
 * built on that helper would import the Prisma graph whether or not it asked
 * for a session — including the ones that read nothing but an in-repo module
 * and have no business dragging a database driver behind them.
 *
 * Splitting it makes the runtime boundary structural: a route's imports are
 * what decide what it can run on, which is a property a reader can see at the
 * top of the file and a bundler can act on, rather than a flag whose
 * consequences are three modules away.
 *
 * That boundary is currently *documentation* rather than deployment, because
 * Next 16's Cache Components forbids the per-route `runtime` export outright —
 * `docs/route-handlers.md` has the reproduction and the citation, and
 * `scripts/assert-api-runtimes.ts` asserts against the build output that it
 * stays that way.
 */
import { auth } from "@/auth";
import { ApiError } from "@/lib/api/errors";
import { defineRoute } from "@/lib/api/define-route";
import type {
  RouteContext,
  RouteHandler,
  RouteSpec,
} from "@/lib/api/define-route";

export type Role = "USER" | "ADMIN";

/**
 * The session a handler is guaranteed. Narrower than `Session`, which types
 * `user` as possibly absent — by the time a handler runs, the guard below has
 * established both the user and the id, so a handler should not have to
 * re-check what it was promised.
 */
export interface AuthedUser {
  id: string;
  role: Role;
  name?: string | null | undefined;
  email?: string | null | undefined;
  image?: string | null | undefined;
}

export interface AuthedRouteContext<
  TQuery,
  TParams,
  TBody,
> extends RouteContext<TQuery, TParams, TBody> {
  user: AuthedUser;
}

export interface AuthedRouteSpec<TQuery, TParams, TBody, TData> extends Omit<
  RouteSpec<TQuery, TParams, TBody, TData>,
  "handler"
> {
  /**
   * Required role. Omitted means "any authenticated user"; `"ADMIN"` answers
   * 403 for a signed-in `USER`, which is a different failure from 401 and a
   * client is entitled to tell them apart.
   */
  role?: Role;
  handler: (
    context: AuthedRouteContext<TQuery, TParams, TBody>,
  ) => Promise<TData> | TData;
}

export function defineAuthedRoute<
  TData,
  TQuery = undefined,
  TParams = undefined,
  TBody = undefined,
>(spec: AuthedRouteSpec<TQuery, TParams, TBody, TData>): RouteHandler<TData> {
  const { role, handler, ...rest } = spec;

  return defineRoute<TData, TQuery, TParams, TBody>({
    ...rest,
    handler: async (context) => {
      const session = await auth();
      const user = session?.user;

      // The id is checked rather than assumed. A session whose JWT predates the
      // `id` callback deserialises to a user without one, and every query below
      // would then filter on `undefined` — which Prisma reads as "no filter",
      // not "no rows".
      if (!user?.id) {
        throw new ApiError("unauthorized", "Authentication required");
      }

      if (role && user.role !== role) {
        throw new ApiError("forbidden", `This route requires the ${role} role`);
      }

      return handler({
        ...context,
        user: {
          id: user.id,
          role: user.role,
          name: user.name,
          email: user.email,
          image: user.image,
        },
      });
    },
  });
}
