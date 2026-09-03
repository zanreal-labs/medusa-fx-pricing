import { describe, expect, it, vi } from "vitest";
import { createRecomputeQueue } from "../recompute-queue";

/**
 * A hand-wound clock, injected through the queue's own `now`/`setTimer`/
 * `clearTimer` seams rather than through `vi.useFakeTimers()`. The behaviour
 * under test IS the timing - "one flush per burst, and never later than the
 * bound" - and a clock the test advances by hand states it in the assertions
 * instead of hiding it in a global.
 */
function fakeClock() {
  let currentTime = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  return {
    advance: (ms: number): void => {
      const target = currentTime + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
          break;
        }
        timers.delete(due[0]);
        currentTime = due[1].at;
        due[1].callback();
      }
      currentTime = target;
    },
    clearTimer: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    now: (): number => currentTime,
    setTimer: (callback: () => void, ms: number): unknown => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { at: currentTime + ms, callback });
      return handle;
    },
  };
}

/**
 * Let every already-queued microtask run. The queue chains its flushes through
 * `.then()`, so a flush starts one microtask after the timer fires, not
 * synchronously with it.
 */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("createRecomputeQueue", () => {
  it("recomputes once for a whole burst, with the union of its variant ids", async () => {
    const clock = fakeClock();
    const flush = vi.fn(async () => undefined);
    const queue = createRecomputeQueue({
      clearTimer: clock.clearTimer,
      flush,
      maxWaitMs: 30_000,
      now: clock.now,
      onError: () => undefined,
      quietMs: 2_000,
      setTimer: clock.setTimer,
    });

    // One admin save of a three-variant product: a product event, a variant
    // event per variant, and a price event, all inside a second.
    queue.add(["variant_1"]);
    clock.advance(200);
    queue.add(["variant_2", "variant_3"]);
    clock.advance(200);
    queue.add(["variant_1"]);

    expect(flush).not.toHaveBeenCalled();

    clock.advance(2_000);
    await queue.settled();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(["variant_1", "variant_2", "variant_3"]);
  });

  it("waits for the burst to go quiet rather than firing on the first event", async () => {
    const clock = fakeClock();
    const flush = vi.fn(async () => undefined);
    const queue = createRecomputeQueue({
      clearTimer: clock.clearTimer,
      flush,
      maxWaitMs: 30_000,
      now: clock.now,
      onError: () => undefined,
      quietMs: 2_000,
      setTimer: clock.setTimer,
    });

    for (let i = 0; i < 5; i += 1) {
      queue.add([`variant_${i}`]);
      clock.advance(1_500);
      expect(flush).not.toHaveBeenCalled();
    }

    clock.advance(2_000);
    await queue.settled();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("flushes at the deadline even if the burst never goes quiet", async () => {
    const clock = fakeClock();
    const batches: string[][] = [];
    const queue = createRecomputeQueue({
      clearTimer: clock.clearTimer,
      flush: async (variantIds: string[]): Promise<void> => {
        batches.push(variantIds);
      },
      maxWaitMs: 10_000,
      now: clock.now,
      onError: () => undefined,
      quietMs: 2_000,
      setTimer: clock.setTimer,
    });

    // A CSV import: events keep arriving faster than the quiet period.
    for (let i = 0; i < 20; i += 1) {
      queue.add([`variant_${i}`]);
      clock.advance(1_000);
    }
    await queue.settled();

    // At least one flush happened before the import finished - the first price
    // does not wait for the last one.
    expect(batches.length).toBeGreaterThanOrEqual(1);
    expect(batches[0]?.length).toBeLessThan(20);
  });

  it("starts a fresh burst after a flush", async () => {
    const clock = fakeClock();
    const flush = vi.fn(async () => undefined);
    const queue = createRecomputeQueue({
      clearTimer: clock.clearTimer,
      flush,
      maxWaitMs: 30_000,
      now: clock.now,
      onError: () => undefined,
      quietMs: 2_000,
      setTimer: clock.setTimer,
    });

    queue.add(["variant_1"]);
    clock.advance(2_000);
    await queue.settled();

    queue.add(["variant_2"]);
    clock.advance(2_000);
    await queue.settled();

    expect(flush.mock.calls).toEqual([[["variant_1"]], [["variant_2"]]]);
  });

  it("never runs two recomputes at once", async () => {
    const clock = fakeClock();
    const releases: (() => void)[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const flush = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      inFlight -= 1;
    });
    const queue = createRecomputeQueue({
      clearTimer: clock.clearTimer,
      flush,
      maxWaitMs: 30_000,
      now: clock.now,
      onError: () => undefined,
      quietMs: 2_000,
      setTimer: clock.setTimer,
    });

    queue.add(["variant_1"]);
    clock.advance(2_000);
    await drainMicrotasks();
    expect(flush).toHaveBeenCalledTimes(1);

    // A second burst lands while the first recompute is still running. Two
    // concurrent passes over overlapping variants would each read the same
    // "before" price and the loser would be locked out as a manual override.
    queue.add(["variant_2"]);
    clock.advance(2_000);
    await drainMicrotasks();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);

    releases[0]?.();
    await drainMicrotasks();
    expect(flush).toHaveBeenCalledTimes(2);

    releases[1]?.();
    await queue.settled();
    expect(maxInFlight).toBe(1);
  });

  it("hands a failed recompute to onError instead of leaving it unhandled", async () => {
    const clock = fakeClock();
    const onError = vi.fn();
    const failure = new Error("NBP is down");
    const queue = createRecomputeQueue({
      clearTimer: clock.clearTimer,
      flush: async () => {
        throw failure;
      },
      maxWaitMs: 30_000,
      now: clock.now,
      onError,
      quietMs: 2_000,
      setTimer: clock.setTimer,
    });

    queue.add(["variant_1"]);
    clock.advance(2_000);
    await queue.settled();

    expect(onError).toHaveBeenCalledWith(failure);

    // And the queue still works afterwards - one failed burst does not wedge it.
    queue.add(["variant_2"]);
    clock.advance(2_000);
    await queue.settled();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("does nothing at all for an empty add", async () => {
    const clock = fakeClock();
    const flush = vi.fn(async () => undefined);
    const queue = createRecomputeQueue({
      clearTimer: clock.clearTimer,
      flush,
      maxWaitMs: 30_000,
      now: clock.now,
      onError: () => undefined,
      quietMs: 2_000,
      setTimer: clock.setTimer,
    });

    queue.add([]);
    clock.advance(30_000);
    await queue.settled();

    expect(flush).not.toHaveBeenCalled();
  });
});
