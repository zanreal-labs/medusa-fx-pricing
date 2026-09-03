import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { FX_PRICING_MODULE, formatError } from "../modules/fx-pricing";
import type FxPricingModuleService from "../modules/fx-pricing/service";
import {
  listVariantIdsByPriceIds,
  listVariantIdsByProductIds,
} from "../workflows/lib/catalog";
import { runFxPricingRecompute } from "../workflows/recompute-fx-prices";
import { FX_PRICING_TRIGGER_EVENTS, parseFxPricingEvent } from "./lib/events";
import type { ParsedFxPricingEvent } from "./lib/events";
import { createRecomputeQueue } from "./lib/recompute-queue";
import type { RecomputeQueue } from "./lib/recompute-queue";

const SUBSCRIBER_NAME = "fx-pricing-price-change-recompute";

/**
 * The native selling currency this plugin derives from - the same `"pln"` the
 * recompute reads its source price in (`findDefaultPrice(variant.prices, "pln")`
 * in `runFxPricingRecompute`). Named here because it is doing a second job in
 * this file: it is the test that tells a price event caused by somebody else
 * apart from one caused by this plugin's own USD/EUR write.
 */
const NATIVE_CURRENCY = "pln";

/**
 * Reprice the affected variants as soon as their PLN price changes, instead of
 * at 03:00 tomorrow.
 *
 * ## Why this exists
 *
 * Until this subscriber, the daily job was the only thing that ever wrote a
 * foreign-currency price. A product created at 09:00, or a PLN price corrected
 * at 09:00, had no USD or EUR price - or had yesterday's, computed from the old
 * PLN amount - for the next eighteen hours, with nothing anywhere saying so. A
 * plugin whose whole promise is "your USD price follows your PLN price" cannot
 * keep that promise on a once-a-day cadence. The job stays, as the backstop for
 * everything an event cannot tell us (a rate that moved, a write that bypassed
 * the workflows, a dropped event) - see `src/jobs/fx-pricing-daily-recompute.ts`.
 *
 * ## The recursion this has to not cause
 *
 * A recompute writes USD and EUR prices through the pricing module's `addPrices`
 * and `updatePrices`, and both are `@EmitEvents()`-decorated, so both emit
 * `pricing.price.created` / `pricing.price.updated` - events this very
 * subscriber is listening for. Handled naively, every run would trigger the next
 * one forever.
 *
 * Two independent things stop that, and the first is the one that is relied on:
 *
 * 1. **A price event is resolved through its currency.** `listVariantIdsByPriceIds`
 *    keeps only prices in PLN, so an event about a price this plugin just wrote
 *    resolves to no variants and the handler returns before anything is queued.
 *    This plugin only ever writes USD and EUR, so its own output can never pass
 *    that test. The `product-variant.*` and `product.*` events need no such
 *    guard: those come from `@medusajs/core-flows`' product workflows, and this
 *    plugin never calls one - it writes through the pricing module directly (see
 *    `src/workflows/lib/price-writes.ts` for why).
 * 2. **A second pass would have nothing to write anyway.** Even if a loop did
 *    start, the recompute's second lap over the same variant finds the price
 *    already at the target amount and still carrying this plugin's stamp -
 *    `decidePriceAction` answers `noop`, nothing is written, and no further event
 *    is emitted. The loop is convergent, not just guarded.
 *
 * ## What one event costs
 *
 * The toggle is checked before anything is queried, so a store with the plugin
 * off (the default - it ships unarmed) pays one indexed single-row read per
 * product save and stops there. When it is on, ids are collected into a
 * coalescing queue and the recompute runs once per burst rather than once per
 * event - see `lib/recompute-queue.ts`, which explains why a burst is the normal
 * case here rather than the exception.
 */
export default async function fxPricingPriceChangeRecomputeHandler({
  container,
  event,
}: SubscriberArgs<unknown>): Promise<void> {
  const parsed = parseFxPricingEvent(event.name, event.data);
  if (!parsed) {
    return;
  }

  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);

  // Checked here as well as inside `runFxPricingRecompute`, the same way the
  // sibling `sanity-product-sync` subscriber checks its module registration in
  // both places. The inner check is what makes the recompute safe to call from
  // anywhere; this one is what stops a store that has never armed the plugin
  // from running a catalog query and holding a debounce timer for every product
  // save it makes.
  const fxPricing: FxPricingModuleService = container.resolve(FX_PRICING_MODULE);
  const { effectiveEnabled } = await fxPricing.getResolvedRuntimeOptions();
  if (!effectiveEnabled) {
    return;
  }

  let variantIds: string[];
  try {
    variantIds = await resolveVariantIds(container, parsed);
  } catch (error) {
    // A resolution failure is one recompute that does not happen now, not a
    // reason to fail the event (which would have the bus retry it, re-running a
    // read that is failing for its own reasons). The daily job still covers it,
    // so this is a warning rather than an error - but it is said out loud,
    // because a subscriber that silently resolves nothing looks exactly like a
    // store where nothing changed.
    logger.warn(
      `[fx-pricing] could not resolve ${event.name} to variants (${formatError(error)}). Those prices will be recomputed by the daily job instead.`,
    );
    return;
  }

  if (variantIds.length === 0) {
    return;
  }

  queueFor(container, logger).add(variantIds);
}

/**
 * The variants an event is about.
 *
 * A `variant` event already names them. A `product` event names a product whose
 * variants have to be looked up - `createProductsWorkflow` and
 * `updateProductsWorkflow` both write variant prices while emitting only the
 * product event. A `price` event names a price row, and is where the currency
 * filter (this plugin's recursion guard) lives.
 */
async function resolveVariantIds(
  container: MedusaContainer,
  parsed: ParsedFxPricingEvent,
): Promise<string[]> {
  switch (parsed.subject) {
    case "variant":
      return [...parsed.ids];
    case "product":
      return await listVariantIdsByProductIds(container, parsed.ids);
    case "price":
      return await listVariantIdsByPriceIds(container, parsed.ids, NATIVE_CURRENCY);
    default: {
      // Exhaustiveness guard - a new `FxPricingEventSubject` must be handled above.
      const neverSubject: never = parsed.subject;
      throw new Error(`Unhandled fx-pricing event subject: ${String(neverSubject)}`);
    }
  }
}

/**
 * One coalescing queue per container.
 *
 * Keyed on the container rather than kept as a single module-level value so the
 * queue can never outlive - or be shared across - the backend instance whose
 * services it resolves against, which matters in tests and in any host that
 * builds more than one container in a process. A `WeakMap` means a discarded
 * container takes its queue with it.
 */
const queues = new WeakMap<MedusaContainer, RecomputeQueue>();

function queueFor(container: MedusaContainer, logger: Logger): RecomputeQueue {
  const existing = queues.get(container);
  if (existing) {
    return existing;
  }

  const queue = createRecomputeQueue({
    flush: async (variantIds: string[]): Promise<void> => {
      const summary = await runFxPricingRecompute(container, { trigger: "event", variantIds });
      if (!summary.ran) {
        // The toggle was flipped off between the event and the flush.
        return;
      }
      // The one line this path logs about itself. A narrowed run does not
      // persist its summary (see `runFxPricingRecompute`), so without this there
      // would be no record anywhere that the event path did anything at all.
      logger.info(
        `[fx-pricing] recomputed ${variantIds.length} variant(s) after a PLN price change: ${summary.pricesWritten} price(s) written${
          summary.error ? ` (run failed: ${summary.error})` : ""
        }`,
      );
    },
    onError: (error: unknown): void => {
      logger.error(
        `[fx-pricing] event-driven recompute failed: ${formatError(error)}. Those variants keep their current USD/EUR prices until the daily job runs.`,
      );
    },
  });

  queues.set(container, queue);
  return queue;
}

export const config: SubscriberConfig = {
  context: { subscriberId: SUBSCRIBER_NAME },
  event: [...FX_PRICING_TRIGGER_EVENTS],
};
