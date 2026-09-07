/**
 * What an outbox event *does*, and why that depends on where it is dispatched
 * from.
 *
 * ## The two contexts are not interchangeable
 *
 * Both of Next's invalidation entry points are illegal outside a specific
 * caller, and both fail at runtime rather than at typecheck:
 *
 *   - `updateTag` and `refresh()` — what `invalidate()` calls — throw outside a
 *     Server Action (E872, E870). `refresh()` in particular signals *the client
 *     that submitted the action* to re-read its uncached data, and the relay
 *     has no such client: nobody is rendering anything when a cron drains the
 *     table.
 *   - `revalidateTag` is the one callable from a Route Handler, which is what
 *     `revalidateFromWebhook` uses.
 *
 * So the same event has to be applied two ways, and the difference is not a
 * detail the caller may forget: a relay that reached for `invalidate()` would
 * throw on every row it claimed, and a unit test with `next/cache` mocked would
 * pass, because the mock is what makes the throw go away. Naming the context is
 * what makes the choice explicit at the one place that knows the answer.
 *
 * ## Why the inline path is not "an optimisation"
 *
 * A mutation dispatches its own events immediately after the transaction
 * commits, in the Server Action, and only what is left over goes to the relay.
 * That is not for speed: `updateTag` is the only one of the two that gives
 * read-your-own-writes, so the person who just clicked Publish sees their post
 * on the blog. Waiting for the relay would mean serving them the copy they were
 * trying to clear, for as long as the relay's interval — which is precisely the
 * bug `@/lib/cache/invalidation` was written to fix.
 *
 * The relay is the *safety net* for that inline dispatch, not the primary path.
 */
import { invalidate, revalidateFromWebhook } from "@/lib/cache/invalidation";
import { cacheMutationFor } from "@/lib/outbox/events";
import type { OutboxEvent } from "@/lib/outbox/events";

/**
 * Where an event is being dispatched from.
 *
 * A closed union rather than a boolean, because the two values name request
 * contexts rather than a setting — and because a third one ("a background job
 * outside the request lifecycle") is a real possibility that cannot use either
 * function, and should be a compile error here rather than a runtime throw.
 */
export type DispatchContext = "server-action" | "route-handler";

/**
 * Applies one event's effects. Returns the cache tags dropped.
 *
 * Returning the tags is what makes the effect assertable — by a test, and by
 * the relay's report, where "claimed 4, dropped 0 tags" is the shape of a
 * consumer that ran and did nothing.
 */
export function dispatchOutboxEvent(
  event: OutboxEvent,
  context: DispatchContext,
): readonly string[] {
  const mutation = cacheMutationFor(event);

  return context === "server-action"
    ? invalidate(mutation)
    : revalidateFromWebhook(mutation);
}
