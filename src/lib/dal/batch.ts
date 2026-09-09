/**
 * A keyed batch loader: N reads of one row each, coalesced into one query.
 *
 * ## Why this is not redundant with Prisma's own batching
 *
 * Prisma ships a dataloader of its own, and it is real — measured against
 * Prisma 7.9.1 over the `pg` adapter, five `findUnique` calls inside one
 * `Promise.all` leave as a single `… WHERE "id" IN ($1,$2,$3,$4,$5)`. The
 * conditions it needs are the problem. Three were measured, and each is a
 * shape a server component produces by accident:
 *
 *  - **Same tick.** Awaiting the reads one after another — which is what a
 *    `for` loop, and what two components rendering at different moments,
 *    produce — emits one statement each. Prisma batches within a tick; a
 *    component tree does not render within a tick.
 *  - **Identical selection set.** Two `findUnique` calls on the same model in
 *    the same tick that ask for different columns are two statements. Two
 *    components rendering the same author, one needing an avatar and one
 *    needing an email, is exactly that.
 *  - **`findUnique` only.** `findFirst` is never batched, at any distance.
 *    Half this repository's by-id reads are `findFirst`, because they carry an
 *    ownership or `published` predicate that `findUnique` will not accept.
 *
 * So Prisma's batcher fires precisely when the calls are already in one
 * `Promise.all` — the case that was never the N+1. This loader covers the
 * other one: it holds a key until the microtask queue drains, groups whatever
 * arrived, and issues one `findMany`.
 *
 * ## Lifetime
 *
 * A loader instance is a cache of rows, so its lifetime is a request and not a
 * process. Constructing one at module scope would share one user's rows with
 * every subsequent request — the same defect `requestMemo` describes, with the
 * blast radius of a row rather than a query. `@/lib/dal/loaders` is the only
 * place instances are made, each behind a zero-argument `cache()` call, and
 * `assert-no-n-plus-one.ts` R6 fails a `createBatchLoader` call anywhere else.
 */

/** What a loader may be keyed on. Both are safe `Map` keys by value. */
export type BatchKey = string | number;

export interface BatchLoaderOptions<K extends BatchKey, V> {
  /** Identifies the loader in error messages. */
  readonly name: string;
  /**
   * Reads every row for `keys` in one query.
   *
   * May return rows in any order and may return fewer than asked for; the
   * loader matches them up with `keyOf` and resolves the rest as `null`. It
   * must not return a row whose key was not requested — that would mean the
   * `where` clause did not say what the caller thinks it says, and the loader
   * throws rather than hand it back.
   */
  readonly fetch: (keys: readonly K[]) => Promise<readonly V[]>;
  /** Recovers the key a row was requested under. */
  readonly keyOf: (value: V) => K;
  /**
   * Largest number of keys in one query. Defaults to 100.
   *
   * An unbounded `IN (...)` is its own pathology: Postgres will plan a list of
   * ten thousand ids, slowly, and the parameter limit is 65535 anyway. Larger
   * batches are split and run concurrently.
   */
  readonly maxBatchSize?: number;
}

export interface BatchLoader<K extends BatchKey, V> {
  /** One row, or `null` if there is none. */
  load(key: K): Promise<V | null>;
  /** Rows for `keys`, positionally, `null` where there is none. */
  loadMany(keys: readonly K[]): Promise<(V | null)[]>;
}

const DEFAULT_MAX_BATCH_SIZE = 100;

export function createBatchLoader<K extends BatchKey, V>(
  options: BatchLoaderOptions<K, V>,
): BatchLoader<K, V> {
  const maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new TypeError(
      `${options.name}: maxBatchSize must be a positive integer, got ${String(maxBatchSize)}`,
    );
  }

  /** Keys already asked for in this request, and what they resolved to. */
  const cache = new Map<K, Promise<V | null>>();

  /**
   * Keys waiting for the next drain, with the promise each `load` handed out.
   *
   * Held separately from `cache` because it is emptied on dispatch while the
   * cache entries survive for the rest of the request.
   */
  let pending: Map<K, Deferred<V | null>> | null = null;

  function schedule(): Map<K, Deferred<V | null>> {
    if (pending) return pending;

    const batch = new Map<K, Deferred<V | null>>();
    pending = batch;

    // A microtask, so everything the current synchronous pass asks for lands in
    // one batch and nothing waits for a timer. `pending` is cleared *before*
    // the fetch rather than after: a `load` issued from inside `fetch` — or
    // from a `.then` on one of these promises — is a new batch, not a late
    // addition to one already in flight, which would never be read.
    queueMicrotask(() => {
      pending = null;
      dispatch(batch);
    });

    return batch;
  }

  function dispatch(batch: Map<K, Deferred<V | null>>): void {
    for (const chunk of chunked([...batch.keys()], maxBatchSize)) {
      // Not awaited in sequence: two chunks are two independent queries and
      // there is nothing to gain by serialising them.
      void runChunk(chunk, batch);
    }
  }

  async function runChunk(
    keys: readonly K[],
    batch: Map<K, Deferred<V | null>>,
  ): Promise<void> {
    try {
      const rows = await options.fetch(keys);

      const byKey = new Map<K, V>();
      for (const row of rows) {
        const key = options.keyOf(row);
        if (!batch.has(key)) {
          throw new Error(
            `${options.name}: fetch returned a row for key ${JSON.stringify(key)}, which was not requested`,
          );
        }
        byKey.set(key, row);
      }

      for (const key of keys) {
        batch.get(key)?.resolve(byKey.get(key) ?? null);
      }
    } catch (error) {
      for (const key of keys) {
        // A rejected read must not stay in the cache. Keeping it would make
        // every later `load` of that key in this request fail with an error
        // raised by a query it never issued, and there would be no way to
        // retry within the request.
        cache.delete(key);
        batch.get(key)?.reject(error);
      }
    }
  }

  function load(key: K): Promise<V | null> {
    // The cache is what deduplicates, and it covers both cases: a key asked for
    // earlier in the request, and a key asked for twice before this batch has
    // been dispatched. Every key put into a batch is put into the cache in the
    // same statement, so there is no third case where the batch holds a key the
    // cache does not.
    const cached = cache.get(key);
    if (cached) return cached;

    const deferred = createDeferred<V | null>();
    schedule().set(key, deferred);
    cache.set(key, deferred.promise);
    return deferred.promise;
  }

  return {
    load,
    // `Promise.all` over `load`, so duplicate keys inside one call collapse the
    // same way duplicates across calls do.
    loadMany: (keys) => Promise.all(keys.map(load)),
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The promise is rejected synchronously by `runChunk` only after a `catch`
  // has been attached by the awaiting caller — but a caller that abandons a
  // `load` would otherwise make this an unhandled rejection and, under
  // `--unhandled-rejections=throw`, kill the process. One no-op handler makes
  // the rejection handled without changing what any caller sees.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
