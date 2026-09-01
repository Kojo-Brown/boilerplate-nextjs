/**
 * Idempotency for Server Actions: the protocol, the fingerprint, and the store
 * interface the protocol runs against.
 *
 * ## What this is actually defending against
 *
 * A Server Action is a POST, and a POST that creates something is duplicated by
 * every ordinary accident a browser produces:
 *
 *   - Two clicks on a submit button before the first render that disables it.
 *     `disabled={isPending}` is set in a React commit, and the second `click`
 *     event can be dispatched before that commit lands.
 *   - A reload, a back-then-forward, or a "Confirm Form Resubmission" while the
 *     first request is still in flight.
 *   - A network layer that retries. A phone switching from Wi-Fi to cellular
 *     mid-request produces a request the client believes failed and the server
 *     completed.
 *
 * In every one of those the *server* sees two legitimate, correctly authorised,
 * correctly validated requests. Nothing in `defineAuthedAction`'s three legs
 * distinguishes them, because there is nothing in the requests themselves that
 * differs. The only thing that can is a value the client mints once per
 * submission and repeats on retry — an idempotency key.
 *
 * ## The protocol
 *
 * Claim, execute, record. The claim is a single `INSERT` against a unique index
 * on `(scope, action, key)`, which is what makes the first-writer question
 * decidable at all: a `SELECT` followed by an `INSERT` has a window between the
 * two statements, and that window is precisely the double-submit. Whoever's
 * insert lands runs the handler; whoever's insert violates the constraint reads
 * the row and gets one of four answers.
 *
 *   claimed         Nobody holds the key. Run the handler.
 *   replay          A completed row with a matching fingerprint. Return its
 *                   stored result without running anything.
 *   in flight       Someone holds an unexpired lease. Refuse — do not run, and
 *                   do not wait: the caller retries, and by then it is a replay.
 *   conflict        The key is held for a *different* payload. Refuse loudly;
 *                   answering with the other request's result would be worse
 *                   than either executing or failing.
 *
 * ## Failures release the key
 *
 * A completed row is only ever written for a success. When the handler throws,
 * the row is deleted, so a retry with the same key is allowed to execute.
 *
 * That is the useful behaviour for the cases that actually happen: a deadlock,
 * a dropped connection, a transient constraint failure. It is also the one
 * that leaves a real hole, and it is worth stating plainly rather than
 * discovering: a handler that writes a row and *then* throws — an
 * `invalidate()` that fails after `prisma.post.create` succeeded — releases the
 * key, and the retry writes a second row. Idempotency keys deduplicate
 * requests; they do not make a handler's own effects atomic. The item that
 * closes that is transactional writes with an outbox row, further down
 * `SPEC.md`; until then, an idempotent handler should do its writing in one
 * Prisma call or one interactive transaction, which `createPostAction` does.
 *
 * ## Why the result is JSON, and why replay needs a schema
 *
 * A stored result is a row in Postgres, so it is JSON, so it is not the value
 * the handler returned. `PostSummary.createdAt` goes in as a `Date` and comes
 * back as a string, and a replayed result that reaches
 * `post.createdAt.toLocaleDateString()` is a `TypeError` in the browser — on the
 * *second* submission only, which is the hardest possible place to notice it.
 *
 * So an idempotent action declares an output schema, and the replay path parses
 * through it. `z.coerce.date()` turns the string back into a `Date`, and the
 * replayed value is the same shape as the fresh one — which
 * `idempotency.test.ts` asserts directly rather than by inspection. It buys a
 * second thing for free: a stored result written by a previous deployment whose
 * shape no longer parses is refused rather than returned.
 */
import { createHash, randomUUID } from "node:crypto";
import { ActionError } from "@/lib/actions/result";

/** How long an in-flight claim stays authoritative before it can be taken over. */
export const IN_FLIGHT_LEASE_MS = 60_000;

/** How long a completed result stays replayable. */
export const COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * What a caller sees when their key is already being processed.
 *
 * Phrased as "try again" rather than "please wait" because that is literally
 * what resolves it: the first attempt finishes, and the retry is a replay that
 * returns the first attempt's result. Blocking here instead — polling until the
 * lease clears — would hold a server connection open for the duration of
 * someone else's request, which is how a double-submit becomes an outage.
 */
export const IN_FLIGHT_MESSAGE =
  "That request is already being processed. Please try again in a moment.";

/** What a caller sees when they reuse a key for a different payload. */
export const KEY_CONFLICT_MESSAGE =
  "This looks like a repeat of a different request. Please reload the page and try again.";

/** What a caller sees when a stored result cannot be revived. */
export const UNREPLAYABLE_MESSAGE =
  "This request was already completed, but its result could not be read back. Please reload the page.";

/** Identifies one key: a principal, an action, and the client's key. */
export interface IdempotencyRecord {
  /** The principal the key belongs to — `user:<id>`. */
  scope: string;
  /** The action name, so one key may be used against two actions. */
  action: string;
  /** The client-generated key. */
  key: string;
}

export interface ClaimRequest extends IdempotencyRecord {
  /** The fingerprint of this attempt's input. */
  fingerprint: string;
  /**
   * Identifies this attempt's hold on the key, so that the two writes which
   * end a claim — `complete` and `release` — can only affect a claim this
   * attempt still owns. See the field's note in `schema.prisma` for the
   * takeover this closes.
   */
  token: string;
  now: Date;
  /** How long the claim is held before another attempt may take it over. */
  leaseMs: number;
}

export type ClaimOutcome =
  | { kind: "claimed" }
  | { kind: "replay"; result: unknown }
  | { kind: "in_flight" }
  | { kind: "conflict" };

/**
 * The three operations the protocol needs from storage.
 *
 * An interface rather than direct Prisma calls so the protocol above can be
 * tested against an in-memory store — including the interleavings that matter,
 * which is not something a test that has to arrange two real concurrent
 * transactions can do cheaply. `@/lib/actions/idempotency-store` is the Prisma
 * implementation, and `idempotency-store.test.ts` is what checks that *it*
 * honours the contract.
 */
export interface IdempotencyStore {
  /** Atomically take the key, or report who holds it. */
  claim(request: ClaimRequest): Promise<ClaimOutcome>;
  /**
   * Record a successful result, if this attempt still holds the claim.
   *
   * A no-op when it does not, rather than an error: losing the claim means the
   * lease expired and someone else took over, which `runIdempotent` handles by
   * carrying on — the handler's effect happened either way.
   */
  complete(
    record: IdempotencyRecord,
    options: {
      token: string;
      result: unknown;
      now: Date;
      retentionMs: number;
    },
  ): Promise<void>;
  /** Give up a claim this attempt holds, so a retry may execute. */
  release(record: IdempotencyRecord, token: string): Promise<void>;
}

/**
 * Thrown by `canonicalise` for a value it cannot fingerprint deterministically.
 *
 * A fault rather than a rejection: everything reaching this point has already
 * been through a Zod schema, so a `Map`, a class instance or a function here
 * means an action declared a schema whose output is not storable — a bug in the
 * action, surfaced at its first call rather than as a fingerprint that silently
 * differs between two identical requests.
 */
export class UnfingerprintableValueError extends Error {
  constructor(description: string) {
    super(`Cannot fingerprint ${description}: it has no canonical form.`);
    this.name = "UnfingerprintableValueError";
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A value's canonical string form — equal strings for equal inputs, whatever
 * order the keys arrived in.
 *
 * `JSON.stringify` is the obvious choice and is wrong here in three ways, each
 * of which turns "the same request" into a different fingerprint and so into a
 * spurious conflict:
 *
 *   - Key order is insertion order. `{ title, content }` and `{ content, title }`
 *     are the same request and stringify differently, and which one a schema
 *     produces depends on the order its `.shape` was declared in versus the
 *     order the properties arrived over the wire.
 *   - `undefined` disappears from objects and becomes `null` in arrays, so
 *     `[1, undefined]` and `[1, null]` collide.
 *   - `Date` stringifies through `toJSON`, which is fine, but a `Map` becomes
 *     `{}` — every `Map` in the world has the same fingerprint.
 *
 * The rules below fix all three. One is a judgement call worth naming: a
 * property whose value is `undefined` is *dropped*, so `{ a: 1, b: undefined }`
 * and `{ a: 1 }` fingerprint identically. That is deliberate. React drops
 * undefined properties when it serialises a Server Action argument, and Zod's
 * `.optional()` produces a present-but-undefined property for some inputs and
 * an absent one for others — so treating the two as different would make the
 * fingerprint depend on plumbing rather than on the request. Inside an array,
 * position is meaningful and `undefined` is kept.
 */
export function canonicalise(value: unknown): string {
  if (value === undefined) return "u";
  if (value === null) return "z";

  switch (typeof value) {
    case "boolean":
      return value ? "t" : "f";
    case "string":
      return `s:${JSON.stringify(value)}`;
    case "bigint":
      return `g:${value.toString()}`;
    case "number":
      // `-0` and `0` are the same request; `Object.is` is the only thing that
      // separates them and nothing downstream does. `NaN` and the infinities
      // stringify to themselves rather than to JSON's `null`.
      return `n:${value === 0 ? "0" : String(value)}`;
    case "function":
      throw new UnfingerprintableValueError("a function");
    case "symbol":
      throw new UnfingerprintableValueError("a symbol");
    default:
      break;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? "d:invalid"
      : `d:${value.toISOString()}`;
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(",")}]`;
  }

  if (typeof value === "object" && isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalise(value[key])}`);

    return `{${entries.join(",")}}`;
  }

  throw new UnfingerprintableValueError(
    `an instance of ${(value as object).constructor?.name ?? "an anonymous class"}`,
  );
}

/**
 * The fingerprint stored alongside a key: SHA-256 over the canonical form.
 *
 * Hashed rather than stored verbatim because the input can be a hundred
 * kilobytes of post content, and this column exists to be compared, never read.
 */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalise(value)).digest("hex");
}

/**
 * The JSON round trip a result makes on its way into the store.
 *
 * Applied here rather than inside the store so that every implementation —
 * Prisma, and the in-memory one the tests use — encodes results identically.
 * A store that kept live object references would let a test pass that the
 * database cannot: the `Date`-becomes-string trap this module's header
 * describes is only visible if the fake store loses the `Date` too.
 */
export function toStoredJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null)) as unknown;
}

export interface IdempotentRun<T> {
  store: IdempotencyStore;
  record: IdempotencyRecord;
  /** This attempt's input fingerprint. */
  fingerprint: string;
  /** Revives a stored result. Throws if it no longer parses. */
  revive: (stored: unknown) => T;
  /** The work being made idempotent. */
  run: () => Promise<T> | T;
  now?: () => Date;
  leaseMs?: number;
  retentionMs?: number;
}

/**
 * Runs `run` at most once per `(scope, action, key)`, replaying the stored
 * result for every later attempt.
 *
 * Throws `ActionError` for the three refusals, so a caller inside
 * `runHardenedAction`'s `try` reports them as an ordinary failed
 * `ActionResult` rather than as a server fault.
 */
export async function runIdempotent<T>(options: IdempotentRun<T>): Promise<T> {
  const {
    store,
    record,
    fingerprint: attemptFingerprint,
    revive,
    run,
    now = () => new Date(),
    leaseMs = IN_FLIGHT_LEASE_MS,
    retentionMs = COMPLETED_RETENTION_MS,
  } = options;

  // One token per attempt, minted here rather than by the store so that every
  // implementation gets the same guarantee and none has to remember to.
  const token = randomUUID();

  const claim = await store.claim({
    ...record,
    fingerprint: attemptFingerprint,
    token,
    now: now(),
    leaseMs,
  });

  if (claim.kind === "in_flight") throw new ActionError(IN_FLIGHT_MESSAGE);
  if (claim.kind === "conflict") throw new ActionError(KEY_CONFLICT_MESSAGE);

  if (claim.kind === "replay") {
    try {
      return revive(claim.result);
    } catch (thrown) {
      // Refuse rather than fall through to `run()`. The work behind this key
      // has already happened; re-running it because its *receipt* is unreadable
      // is the duplicate this module exists to prevent, and a caller who sees
      // an error will reload, at which point the row is simply there.
      console.error(
        `[idempotency] ${record.action}: stored result is no longer readable:`,
        thrown,
      );
      throw new ActionError(UNREPLAYABLE_MESSAGE);
    }
  }

  let value: T;
  try {
    value = await run();
  } catch (thrown) {
    // Best-effort: a release that fails leaves the key held until its lease
    // expires, which is recoverable. Masking the handler's error with the
    // release's would not be.
    try {
      await store.release(record, token);
    } catch (releaseFailure) {
      console.error(
        `[idempotency] ${record.action}: could not release key after a failure:`,
        releaseFailure,
      );
    }
    throw thrown;
  }

  try {
    await store.complete(record, {
      token,
      result: toStoredJson(value),
      now: now(),
      retentionMs,
    });
  } catch (thrown) {
    // The handler's effect is committed. Failing the action here would tell the
    // caller their post was not created when it was — which is the one answer
    // guaranteed to produce the duplicate submission. The cost of carrying on
    // is that the key stays in flight until its lease expires and a much later
    // retry re-executes; the cost of not is a duplicate now.
    console.error(
      `[idempotency] ${record.action}: could not record the result for replay:`,
      thrown,
    );
  }

  return value;
}
