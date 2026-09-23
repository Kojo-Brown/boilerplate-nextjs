/**
 * Where the session chain lives.
 *
 * One interface, one Prisma implementation, one in-memory implementation for
 * tests — the same shape `@/lib/rate-limit/store` uses, and for a related
 * reason: the operation that matters is a read-modify-write that two concurrent
 * requests will attempt at the same moment, so it belongs *inside* the store
 * where it can be made atomic, not in the caller.
 *
 * The difference from the rate limiter is which way the failure points. An
 * under-counted rate limit lets a few extra requests through. A rotation that
 * two requests both believe they won leaves one of them holding a `tid` the
 * registry has never heard of — which `classifyToken` reads as reuse, and reuse
 * revokes the session. Getting this wrong does not weaken a defence, it fires
 * it at the user. Hence `rotate` is a compare-and-swap and reports losing.
 */
import { prisma } from "@/lib/prisma";
import { absoluteDeadline, graceDeadline } from "@/lib/auth/policy";

/**
 * Why a session ended. Mirrors the Prisma enum; re-declared as a union so the
 * pure modules here and their tests do not have to import a generated client.
 */
export type SessionRevocationReason =
  "SIGNED_OUT" | "TOKEN_REUSE" | "ABSOLUTE_TIMEOUT" | "REVOKED_BY_USER";

/** The fields a decision is made from. Deliberately not the whole row. */
export interface SessionFamilyRecord {
  id: string;
  userId: string;
  currentTokenId: string;
  previousTokenId: string | null;
  previousValidUntil: Date | null;
  revokedAt: Date | null;
}

export interface StartSessionInput {
  sid: string;
  userId: string;
  tid: string;
  now: Date;
}

export interface RotateSessionInput {
  sid: string;
  /** The `tid` the caller read, and the value the swap is conditional on. */
  from: string;
  /** The `tid` the caller wants to mint. */
  to: string;
  now: Date;
}

export interface SessionRegistry {
  /** Records a new sign-in. */
  start(input: StartSessionInput): Promise<void>;

  /** The row for a `sid`, or `null` if there is none. */
  find(sid: string): Promise<SessionFamilyRecord | null>;

  /**
   * Advances the chain, but only if `currentTokenId` is still `from`.
   *
   * Returns `true` when this caller won the swap and `false` when another
   * request had already rotated — which is not an error and must not be
   * treated as one. The loser keeps carrying `from`, which is now the previous
   * token and inside its grace window, so its request is served normally and
   * the browser simply gets the winner's cookie.
   */
  rotate(input: RotateSessionInput): Promise<boolean>;

  /**
   * Ends a session. Idempotent: revoking an already-revoked family is a no-op.
   *
   * Deliberately the only write here besides `start` and `rotate`. "Revoke
   * every session for this user" — what a password change owes — is a single
   * `updateMany` on `userId` and is written out in `docs/session-hardening.md`,
   * but it is not on this interface: there is no password change in this
   * application yet, and a security method with no caller is the shape of the
   * `src/actions/blog.ts` helper that sat fully unit-tested and imported by
   * nobody while the bug it would have fixed was live.
   */
  revoke(
    sid: string,
    reason: SessionRevocationReason,
    now: Date,
  ): Promise<void>;
}

/** The default: one indexed row per sign-in, in the application's database. */
export class PrismaSessionRegistry implements SessionRegistry {
  async start({ sid, userId, tid, now }: StartSessionInput): Promise<void> {
    await prisma.sessionFamily.create({
      data: {
        id: sid,
        userId,
        currentTokenId: tid,
        startedAt: now,
        lastSeenAt: now,
        expiresAt: absoluteDeadline(now),
      },
    });
  }

  async find(sid: string): Promise<SessionFamilyRecord | null> {
    return prisma.sessionFamily.findUnique({
      where: { id: sid },
      select: {
        id: true,
        userId: true,
        currentTokenId: true,
        previousTokenId: true,
        previousValidUntil: true,
        revokedAt: true,
      },
    });
  }

  /**
   * The compare-and-swap.
   *
   * `updateMany` rather than `update` because the condition is not the primary
   * key alone: the `where` has to carry `currentTokenId` so that the database
   * decides who won, in one statement. `update` would need a unique index on
   * that pair, and a read-then-write would reintroduce exactly the interleaving
   * this exists to survive — both requests read `from`, both write, and the
   * second erases the first's `previousTokenId`, stranding a token the browser
   * is already carrying.
   *
   * `revokedAt: null` is in the condition too, so a rotation cannot resurrect a
   * family that was revoked between the read and this write.
   */
  async rotate({ sid, from, to, now }: RotateSessionInput): Promise<boolean> {
    const { count } = await prisma.sessionFamily.updateMany({
      where: { id: sid, currentTokenId: from, revokedAt: null },
      data: {
        currentTokenId: to,
        previousTokenId: from,
        previousValidUntil: graceDeadline(now),
        lastSeenAt: now,
        rotations: { increment: 1 },
      },
    });

    return count === 1;
  }

  /**
   * `updateMany` again, and again for the condition rather than the cardinality:
   * `revokedAt: null` keeps the first reason. A family revoked for `TOKEN_REUSE`
   * that is then signed out by the victim's own browser must still read
   * `TOKEN_REUSE` when somebody comes to look at it.
   */
  async revoke(
    sid: string,
    reason: SessionRevocationReason,
    now: Date,
  ): Promise<void> {
    await prisma.sessionFamily.updateMany({
      where: { id: sid, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
  }
}

/**
 * The same contract over a `Map`.
 *
 * For tests, and for nothing else — it is per-process, so a deployment running
 * more than one instance would detect reuse only when the replay happened to
 * land on the instance that minted the token, and would deny every request
 * that did not. Unlike the rate limiter's memory store, which degrades to a
 * weaker limit, this one degrades to *denying valid sessions*, which is why it
 * is not offered as a default anywhere.
 */
export class MemorySessionRegistry implements SessionRegistry {
  readonly #families = new Map<string, SessionFamilyRecord>();

  async start({ sid, userId, tid }: StartSessionInput): Promise<void> {
    this.#families.set(sid, {
      id: sid,
      userId,
      currentTokenId: tid,
      previousTokenId: null,
      previousValidUntil: null,
      revokedAt: null,
    });
  }

  async find(sid: string): Promise<SessionFamilyRecord | null> {
    const record = this.#families.get(sid);
    return record ? { ...record } : null;
  }

  async rotate({ sid, from, to, now }: RotateSessionInput): Promise<boolean> {
    const record = this.#families.get(sid);
    if (!record || record.revokedAt !== null) return false;
    if (record.currentTokenId !== from) return false;

    this.#families.set(sid, {
      ...record,
      currentTokenId: to,
      previousTokenId: from,
      previousValidUntil: graceDeadline(now),
    });
    return true;
  }

  async revoke(
    sid: string,
    _reason: SessionRevocationReason,
    now: Date,
  ): Promise<void> {
    const record = this.#families.get(sid);
    if (!record || record.revokedAt !== null) return;
    this.#families.set(sid, { ...record, revokedAt: now });
  }
}

/**
 * The registry the application uses.
 *
 * A module-scope instance rather than a factory because it holds no state of
 * its own — every method is a statement against the Prisma singleton — and a
 * per-request instance would only add an allocation to the hot path.
 */
export const sessionRegistry: SessionRegistry = new PrismaSessionRegistry();
