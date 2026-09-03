/**
 * Collecting a burst of variant ids into one recompute.
 *
 * ## Why a burst is the normal case, not the exception
 *
 * Saving a product with nine variants emits nine `product-variant.updated`
 * events. A CSV import emits thousands. A single admin price edit emits a
 * product event AND a variant event AND a pair of price events, all naming the
 * same variant. Every one of those, handled on its own, would fetch the NBP
 * table A rate for USD and again for EUR - two HTTPS round trips to a public
 * central-bank API per event, for a result that is identical across the whole
 * burst because the published rate does not change while an import runs.
 *
 * So the ids are collected and the recompute runs once, after the burst goes
 * quiet: one rate fetch, one filtered catalog read, one pass over the union.
 * The delay is the point - firing after the LAST write rather than the first
 * also means the recompute reads the finished state of a multi-step save
 * instead of a half-written one.
 *
 * ## Why it is in-process and not a lock plus a cache key
 *
 * The sibling `marketing-price-revalidate` subscriber in `zanreal-labs/medusa`
 * coalesces through the locking and cache modules, because it fires ONE webhook
 * that means "re-read everything" and two workers doing that twice is pure
 * waste. This queue coalesces work that is already partitioned by variant id:
 * two workers each holding half a burst produce two runs over disjoint variant
 * sets, which is the correct answer, just reached in two passes instead of one.
 * Buying cross-worker coordination for that would add two module dependencies
 * and a distributed lock to save one NBP request.
 *
 * What that costs, stated plainly: ids held here are lost if the process exits
 * before the flush. The daily job is the backstop for exactly this - see
 * `src/jobs/fx-pricing-daily-recompute.ts`.
 */

/** Wait this long after the last event of a burst before recomputing. */
export const DEFAULT_QUIET_MS = 2_000;

/**
 * The longest a burst may hold ids before flushing anyway. A catalogue-wide
 * import can keep events arriving for minutes; without this the first price
 * would wait for the last one. Hitting the bound just flushes early - whatever
 * arrives afterwards starts a fresh burst.
 */
export const DEFAULT_MAX_WAIT_MS = 30_000;

export interface RecomputeQueueOptions {
  /** Recompute these variant ids. Rejections are handed to `onError`, never thrown at a caller of `add`. */
  flush: (variantIds: string[]) => Promise<void>;
  onError: (error: unknown) => void;
  quietMs?: number;
  maxWaitMs?: number;
  /** Injected by the tests so the timing can be exercised without waiting for it. */
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface RecomputeQueue {
  /** Add ids to the current burst, (re)starting the quiet-period countdown. */
  add: (variantIds: readonly string[]) => void;
  /**
   * Resolves once every flush started so far has finished. For tests, and for a
   * caller that wants to wait one out; nothing in the subscriber path awaits it.
   */
  settled: () => Promise<void>;
}

export function createRecomputeQueue(options: RecomputeQueueOptions): RecomputeQueue {
  const {
    clearTimer = clearTimeout,
    flush,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    now = Date.now,
    onError,
    quietMs = DEFAULT_QUIET_MS,
    setTimer = setTimeout,
  } = options;

  const pending = new Set<string>();
  let timer: unknown;
  let burstStartedAt = 0;
  // Flushes are chained rather than run concurrently: two overlapping recomputes
  // over overlapping variant sets would both read the same "before" prices and
  // both plan the same write, and the second would then find a price it did not
  // stamp and skip that variant as a manual override - permanently.
  let running: Promise<void> = Promise.resolve();

  const fire = (): void => {
    timer = undefined;
    if (pending.size === 0) {
      return;
    }
    const variantIds = [...pending];
    pending.clear();
    running = running.then(() => flush(variantIds)).catch(onError);
  };

  const schedule = (): void => {
    if (timer !== undefined) {
      clearTimer(timer);
    }
    // Never past the burst's own deadline: `maxWaitMs` is measured from the
    // FIRST id of the burst, so a stream of events cannot keep pushing it out.
    const remaining = maxWaitMs - (now() - burstStartedAt);
    timer = setTimer(fire, Math.max(0, Math.min(quietMs, remaining)));
    // A pending recompute should not be the reason a backend refuses to exit.
    (timer as { unref?: () => void })?.unref?.();
  };

  return {
    add: (variantIds: readonly string[]): void => {
      if (variantIds.length === 0) {
        return;
      }
      if (pending.size === 0) {
        burstStartedAt = now();
      }
      for (const variantId of variantIds) {
        pending.add(variantId);
      }
      schedule();
    },
    settled: async (): Promise<void> => {
      await running;
    },
  };
}
