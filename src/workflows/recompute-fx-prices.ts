import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import {
  FX_PRICING_MODULE,
  MARGIN_NOT_CONFIGURED_MESSAGE,
  describeError,
  fetchNbpRate,
  formatError,
  isRateStale,
} from "../modules/fx-pricing";
import type {
  CurrencyRunSummary,
  FxPricingRunTrigger,
  FxSourceCurrency,
  RunSummary,
} from "../modules/fx-pricing";
import type FxPricingModuleService from "../modules/fx-pricing/service";
import {
  fetchPriceSetIdsByVariantIds,
  fetchStoreSupportedCurrencyCodes,
  fetchVariantPricesByIds,
  listCatalogVariants,
  listCatalogVariantsByIds,
} from "./lib/catalog";
import { planCurrencyRecompute } from "./lib/plan";
import type { PlannedWrite, VariantForPlanning } from "./lib/plan";
import { resolvePriceWriter } from "./lib/price-writes";
import type { PriceWriter } from "./lib/price-writes";
import { findDefaultPrice, hasQuantityTieredPrice } from "./lib/variant-prices";

const TARGET_CURRENCIES: readonly FxSourceCurrency[] = ["usd", "eur"];

/**
 * A currency's counters before the run has looked at it.
 *
 * `reached: false` is the important default. Every target currency is seeded
 * into the summary up front, so a run that ends early reports the currencies it
 * never got to as "not reached" instead of leaving them out. The 2026-08-27
 * production run omitted `eur` from its summary entirely; nothing in the record
 * distinguished that from EUR having been fine.
 */
function emptyCurrencySummary(): CurrencyRunSummary {
  return {
    created: 0,
    currencyDisabled: false,
    failed: false,
    plannedCreates: 0,
    plannedUpdates: 0,
    rateStale: false,
    rateUnavailable: false,
    reached: false,
    skippedManualOverride: 0,
    skippedNoPlnPrice: 0,
    skippedQuantityTiered: 0,
    stampFailed: 0,
    unchanged: 0,
    updated: 0,
  };
}

/** A run that did nothing because the toggle is off - the module service's `effectiveEnabled` was `false`. */
function skippedDisabledSummary(
  trigger: FxPricingRunTrigger,
  scopedVariantIds: readonly string[] | undefined,
): RunSummary {
  return {
    currencies: {},
    pricesWritten: 0,
    ran: false,
    ranAt: new Date().toISOString(),
    scopedVariantCount: scopedVariantIds?.length ?? null,
    trigger,
  };
}

/**
 * How a caller narrows and labels one recompute run.
 */
export interface FxPricingRecomputeOptions {
  /**
   * Recompute only these variant ids, leaving the rest of the catalog
   * untouched. `undefined` - the default - is the full pass the daily backstop
   * job makes.
   *
   * An EMPTY array is deliberately NOT the same as `undefined`: it is honoured
   * literally as "no variants", and the run ends without reading a rate or a
   * price. A subscriber that resolved its event down to nothing must never fall
   * through into repricing the whole store, and "empty means everything" is
   * exactly how that would happen.
   */
  variantIds?: readonly string[];
  /** What set this run going. Defaults to `"scheduled"` - see `FxPricingRunTrigger`. */
  trigger?: FxPricingRunTrigger;
}

/**
 * Write one planned price and, only if that landed, record the ownership stamp
 * for it.
 *
 * The order is not negotiable and neither is the "only if". An unstamped price
 * is, by this plugin's own rule, somebody else's price forever
 * (`decidePriceAction` skips a price it has no record of writing), so a price
 * written without a stamp is a variant+currency this plugin has permanently
 * locked itself out of. That is why a stamp failure is counted, logged as a
 * warning and never rolled into `created`/`updated`: those two count prices
 * that are both live and owned, which is the only combination that means the
 * next run can keep them up to date.
 *
 * The written price is re-read rather than taken from the write's return value,
 * for the same reason the previous implementation did: the stamp has to carry
 * the AUTHORITATIVE price id and amount, which is what the database says, not
 * what we asked for.
 */
async function applyWrite(options: {
  currency: FxSourceCurrency;
  logger: Logger;
  priceSetId: string | undefined;
  write: PlannedWrite;
  writer: PriceWriter;
}): Promise<boolean> {
  const { currency, logger, priceSetId, write, writer } = options;
  const isUpdate = write.priceId !== undefined;

  if (isUpdate) {
    await writer.updatePrices([{ amount: write.targetAmount, id: write.priceId as string }]);
  } else {
    if (!priceSetId) {
      // A variant with no price set has never been priced in any currency, and
      // this plugin only ever prices variants that already have a PLN price -
      // so reaching here means the catalog read and the link read disagree.
      // Reported, not guessed at: creating a price set here is exactly what
      // broke the write path in the first place (see `price-writes.ts`). The
      // skip shows up as a gap between `plannedCreates` and `created`.
      logger.warn(
        `[fx-pricing] variant ${write.variantId} has a PLN price but no price set link - cannot add a ${currency.toUpperCase()} price to it. Skipped.`,
      );
      return false;
    }
    await writer.addPrices([
      { priceSetId, prices: [{ amount: write.targetAmount, currency_code: currency }] },
    ]);
  }

  return true;
}

/**
 * The whole recompute, as a plain async function - not a `createStep` body
 * directly, so it can be called straight from the scheduled job, the manual
 * "recompute now" admin route and the subscriber, the same way the sibling
 * `medusa-allegro` plugin's `runOfferDiscovery` is (see that plugin's
 * `src/jobs/allegro-offer-sync.ts` and `src/api/admin/allegro/sync/route.ts`
 * for the precedent). `recomputeFxPricesWorkflow` below wraps this same
 * function in a one-step workflow for callers that want it composed into a
 * larger workflow.
 *
 * Gated by the toggle INSIDE this function (not by each caller separately),
 * so the job, the manual action and the subscriber can never disagree about
 * whether they are allowed to run - all three call this and all three get the
 * same `{ ran: false }` when the plugin is off, and all three log/report from
 * the same `RunSummary` shape.
 *
 * `options.variantIds` narrows the run to specific variants. That is what makes
 * the event-driven path possible at all: a product save can reprice the two
 * variants it touched in a filtered query instead of rescanning the catalog.
 * The narrowing changes only WHICH variants are read - every rule below (the
 * toggle, the margin refusal, the per-currency skips, the manual-override
 * decision, the stamping) applies identically, because there is exactly one
 * implementation of them.
 *
 * ## What this function promises about its own report
 *
 * Everything below is a reaction to the 2026-08-27 03:00 production run, which
 * recorded `usd: { created: 61 }` while not a single `price` row had been
 * written, omitted `eur` entirely, and preserved its failure as the string
 * `"[object Object]"`:
 *
 * 1. **Every target currency appears in the summary**, seeded before the loop,
 *    with `reached: false` until its turn actually comes.
 * 2. **One currency's failure does not end the run.** It is caught, recorded on
 *    that currency, and the next currency is still attempted. EUR should not go
 *    unpriced because USD broke.
 * 3. **`created`/`updated` count prices that landed AND were stamped**, never
 *    the plan. The plan's own numbers are kept separately as
 *    `plannedCreates`/`plannedUpdates`, so the two can be compared instead of
 *    being confused for each other.
 * 4. **Errors are preserved through `describeError`**, which reads the message
 *    off Medusa's serialized non-`Error` throws instead of stringifying them
 *    into nothing.
 * 5. **A run that writes nothing says so**, with the numbers that explain why.
 */
export async function runFxPricingRecompute(
  container: MedusaContainer,
  options: FxPricingRecomputeOptions = {},
): Promise<RunSummary> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const fxPricing: FxPricingModuleService = container.resolve(FX_PRICING_MODULE);
  const scopedVariantIds = options.variantIds;
  const trigger = options.trigger ?? "scheduled";
  // Appended to the per-currency log line only when the run IS narrowed, so a
  // full pass logs exactly what it always logged and a narrowed one is never
  // mistaken for a catalog-wide result.
  const scopeSuffix =
    scopedVariantIds === undefined
      ? ""
      : ` (${scopedVariantIds.length} variant${scopedVariantIds.length === 1 ? "" : "s"})`;

  const runtimeOptions = await fxPricing.getResolvedRuntimeOptions();
  if (!runtimeOptions.effectiveEnabled) {
    const reason = runtimeOptions.forceDisabled
      ? "disabled (FX_PRICING_DISABLED is set)"
      : "disabled (Settings > FX pricing)";
    logger.info(`[fx-pricing] skipped (${reason})`);
    return skippedDisabledSummary(trigger, scopedVariantIds);
  }

  const summary: RunSummary = {
    currencies: {},
    pricesWritten: 0,
    ran: true,
    ranAt: new Date().toISOString(),
    scopedVariantCount: scopedVariantIds?.length ?? null,
    trigger,
  };
  // Seeded before anything can fail, so an aborted run still reports every
  // currency it was supposed to price - see promise 1 above.
  for (const currency of TARGET_CURRENCIES) {
    summary.currencies[currency] = emptyCurrencySummary();
  }

  if (scopedVariantIds !== undefined && scopedVariantIds.length === 0) {
    // Narrowed to nothing. Returned here rather than falling into the loop so
    // an event that resolved to no variants costs no NBP request - see
    // `FxPricingRecomputeOptions.variantIds` for why this is not treated as
    // "the whole catalog".
    return summary;
  }

  try {
    // Read once, before anything is fetched or planned. `null` here means no
    // margin is configured in either place, and this plugin ships without a
    // default one on purpose - see `FxPricingModuleOptions.marginMultiplier`.
    // Refusing the whole run is the only honest option: a guessed markup
    // would be written straight onto customer-facing prices, and the operator
    // would have no way to tell it apart from a number they chose.
    const { marginMultiplier } = runtimeOptions;
    if (marginMultiplier === null) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, MARGIN_NOT_CONFIGURED_MESSAGE);
    }

    // Asserted before the first currency rather than at the first write: a
    // pricing module that cannot write single prices is a refusal, not a
    // per-variant failure.
    const writer = resolvePriceWriter(container);

    const [supportedCurrencies, catalogVariants] = await Promise.all([
      fetchStoreSupportedCurrencyCodes(container),
      scopedVariantIds === undefined
        ? listCatalogVariants(container)
        : listCatalogVariantsByIds(container, scopedVariantIds),
    ]);

    for (const currency of TARGET_CURRENCIES) {
      const currencySummary = summary.currencies[currency] as CurrencyRunSummary;
      currencySummary.reached = true;

      try {
        if (!supportedCurrencies.has(currency)) {
          currencySummary.currencyDisabled = true;
          logger.info(
            `[fx-pricing] skipped ${currency.toUpperCase()} (not enabled in the store's supported currencies)`,
          );
          continue;
        }

        let rate: Awaited<ReturnType<typeof fetchNbpRate>>;
        try {
          rate = await fetchNbpRate(currency);
        } catch (error) {
          currencySummary.rateUnavailable = true;
          currencySummary.error = formatError(error);
          logger.warn(
            `[fx-pricing] skipped ${currency.toUpperCase()} (NBP rate fetch failed: ${currencySummary.error})`,
          );
          continue;
        }

        currencySummary.rate = rate.mid;
        currencySummary.rateEffectiveDate = rate.effectiveDate;

        if (isRateStale(rate, new Date(), runtimeOptions.stalenessToleranceHours)) {
          currencySummary.rateStale = true;
          logger.warn(
            `[fx-pricing] skipped ${currency.toUpperCase()} (latest NBP rate is from ${rate.effectiveDate}, older than the ${runtimeOptions.stalenessToleranceHours}h staleness tolerance)`,
          );
          continue;
        }

        const plannableVariants = catalogVariants.map((variant): VariantForPlanning => {
          const plnPrice = findDefaultPrice(variant.prices, "pln");
          const existingPrice = findDefaultPrice(variant.prices, currency);
          return {
            existingDefaultPrice: existingPrice
              ? { amount: existingPrice.amount, id: existingPrice.id }
              : null,
            managedRecord: null,
            plnAmount: plnPrice?.amount,
            productId: variant.productId,
            // Two separate reasons, one counter. Never WRITE into a currency
            // that is priced as a quantity ladder - there is no unbounded row
            // to move and adding one alongside the ladder is a pricing decision
            // nobody made. And never DERIVE from a PLN ladder either, when
            // there is no unbounded PLN price to derive from; picking a tier
            // would price USD off a hundred-seat rate.
            quantityTiered:
              hasQuantityTieredPrice(variant.prices, currency) ||
              (plnPrice === undefined && hasQuantityTieredPrice(variant.prices, "pln")),
            variantId: variant.id,
          };
        });

        // Narrowing here keeps the managed-price read below to the variants that
        // could actually produce a write. The variants dropped by this filter are
        // exactly the "no default PLN price" and "priced as a quantity ladder"
        // cases the summary reports, so they are counted HERE rather than inside
        // `planCurrencyRecompute` - the planner never sees them, so its own
        // branches for them cannot count them.
        const candidates = plannableVariants.filter(
          (variant) => !variant.quantityTiered && variant.plnAmount !== undefined,
        );
        const skippedQuantityTiered = plannableVariants.filter(
          (variant) => variant.quantityTiered,
        ).length;
        const skippedNoPlnPrice =
          plannableVariants.length - candidates.length - skippedQuantityTiered;

        currencySummary.skippedNoPlnPrice = skippedNoPlnPrice;
        currencySummary.skippedQuantityTiered = skippedQuantityTiered;

        if (candidates.length === 0) {
          // Still report them. A store where no variant carries a PLN price is the
          // most extreme form of this skip, not an absence of it.
          continue;
        }

        const managedRecords = await fxPricing.getManagedPricesByVariantIds(
          candidates.map((variant) => variant.variantId),
          currency,
        );
        for (const variant of candidates) {
          const record = managedRecords.get(variant.variantId);
          variant.managedRecord = record ? { amount: record.amount, priceId: record.price_id } : null;
        }

        const plan = planCurrencyRecompute(candidates, rate.mid, marginMultiplier);
        currencySummary.plannedCreates = plan.created;
        currencySummary.plannedUpdates = plan.updated;
        currencySummary.unchanged = plan.unchanged;
        currencySummary.skippedManualOverride = plan.skippedManualOverride;
        // Both halves: variants filtered out above, plus variants the planner
        // itself refused because their PLN amount could not produce a real
        // target (see `computeForeignAmount`).
        currencySummary.skippedNoPlnPrice = skippedNoPlnPrice + plan.skippedNoPlnPrice;
        currencySummary.skippedQuantityTiered = skippedQuantityTiered + plan.skippedQuantityTiered;

        if (plan.writes.length > 0) {
          const priceSetIds = await fetchPriceSetIdsByVariantIds(
            container,
            plan.writes.map((write) => write.variantId),
          );

          const written: PlannedWrite[] = [];
          for (const write of plan.writes) {
            const applied = await applyWrite({
              currency,
              logger,
              priceSetId: priceSetIds.get(write.variantId),
              write,
              writer,
            });
            if (applied) {
              written.push(write);
            }
          }

          // Re-read the touched variants rather than trusting the write's own
          // return shape - see the module comment on `FxManagedPrice` for
          // why the tracking row needs the AUTHORITATIVE price id/amount.
          const refreshed = await fetchVariantPricesByIds(
            container,
            written.map((write) => write.variantId),
          );
          for (const write of written) {
            const refreshedPrices = refreshed.get(write.variantId) ?? [];
            const writtenPrice = findDefaultPrice(refreshedPrices, currency);
            if (!writtenPrice) {
              currencySummary.stampFailed += 1;
              logger.warn(
                `[fx-pricing] wrote a ${currency.toUpperCase()} price for variant ${write.variantId} but could not read it back, so it is UNSTAMPED - this plugin will treat it as a manual override from now on and never update it. Delete that price to hand it back.`,
              );
              continue;
            }
            try {
              await fxPricing.recordManagedPrice({
                amount: writtenPrice.amount,
                currencyCode: currency,
                marginMultiplier,
                nbpRate: rate.mid,
                priceId: writtenPrice.id,
                sourcePlnAmount: write.sourcePlnAmount,
                variantId: write.variantId,
              });
            } catch (error) {
              currencySummary.stampFailed += 1;
              logger.warn(
                `[fx-pricing] wrote a ${currency.toUpperCase()} price for variant ${write.variantId} but could not stamp it (${formatError(error)}) - this plugin will treat it as a manual override from now on and never update it. Delete that price to hand it back.`,
              );
              continue;
            }
            if (write.priceId === undefined) {
              currencySummary.created += 1;
            } else {
              currencySummary.updated += 1;
            }
            summary.pricesWritten += 1;
          }
        }

        logger.info(
          `[fx-pricing] ${currency.toUpperCase()}${scopeSuffix}: rate=${rate.mid} (${rate.effectiveDate}) created=${currencySummary.created}/${currencySummary.plannedCreates} updated=${currencySummary.updated}/${currencySummary.plannedUpdates} unchanged=${currencySummary.unchanged} skippedManualOverride=${currencySummary.skippedManualOverride} skippedNoPlnPrice=${currencySummary.skippedNoPlnPrice} skippedQuantityTiered=${currencySummary.skippedQuantityTiered} stampFailed=${currencySummary.stampFailed}`,
        );
      } catch (error) {
        // One currency's failure is that currency's failure. The next one is
        // still attempted - EUR going unpriced because USD broke is how the
        // 2026-08-27 run came to have no EUR line at all.
        const described = describeError(error);
        currencySummary.failed = true;
        currencySummary.error = formatError(error);
        logger.error(
          `[fx-pricing] ${currency.toUpperCase()} failed: ${currencySummary.error}${
            described.stack ? `\n${described.stack}` : ""
          }`,
        );
      }
    }
  } catch (error) {
    // `describeError`, not `String(error)`. A Medusa workflow throws the
    // orchestrator's SERIALIZED error - a plain object, not an `Error`
    // instance - so `instanceof Error` is false and `String()` renders it as
    // "[object Object]", which is exactly what the 2026-08-27 run persisted
    // and all anyone has of that failure. See `lib/errors.ts`.
    const described = describeError(error);
    summary.error = described.message;
    summary.errorName = described.name;
    summary.errorStack = described.stack;
    logger.error(
      `[fx-pricing] recompute run failed: ${formatError(error)}${
        described.stack ? `\n${described.stack}` : ""
      }`,
    );
  }

  if (summary.ran && summary.error === undefined && summary.pricesWritten === 0) {
    // A run that touched nothing and said nothing looks identical to a run that
    // worked. Say it in numbers instead.
    const reasons = TARGET_CURRENCIES.map((currency) => {
      const currencySummary = summary.currencies[currency];
      if (!currencySummary) {
        return `${currency.toUpperCase()}: not reported`;
      }
      return `${currency.toUpperCase()}: unchanged=${currencySummary.unchanged} manualOverride=${currencySummary.skippedManualOverride} noPlnPrice=${currencySummary.skippedNoPlnPrice} quantityTiered=${currencySummary.skippedQuantityTiered} stampFailed=${currencySummary.stampFailed}`;
    }).join("; ");
    const message = `[fx-pricing] finished without writing a single price${scopeSuffix}. ${reasons}`;
    // A FULL pass that writes nothing is the thing promise 5 exists to shout
    // about. A NARROWED one is the ordinary outcome of saving a product whose
    // PLN price did not move - warning on every one of those would train an
    // operator to ignore the warning that matters.
    if (scopedVariantIds === undefined) {
      logger.warn(message);
    } else {
      logger.debug(message);
    }
  }

  if (scopedVariantIds === undefined) {
    // Only a full pass is persisted. `last_run_summary` is a single column and
    // Settings > FX pricing renders it as "the last run" - letting a
    // two-variant, event-driven run overwrite it would replace the catalog-wide
    // picture with counters that are true of two variants and of nothing else,
    // dozens of times a day. Narrowed runs report themselves in the log instead;
    // see `src/subscribers`.
    try {
      await fxPricing.recordRunSummary(summary);
    } catch (error) {
      logger.warn(
        `[fx-pricing] recompute finished but the run summary could not be persisted: ${formatError(error)}`,
      );
    }
  }

  return summary;
}

const recomputeFxPricesStep = createStep(
  "recompute-fx-prices",
  async (_input: void, { container }: { container: MedusaContainer }) =>
    new StepResponse(await runFxPricingRecompute(container, { trigger: "workflow" })),
);

/**
 * The recompute as a workflow, for a caller that wants it composed into a
 * larger workflow (or invoked through the workflow engine for its
 * idempotency-key/retry support) rather than calling `runFxPricingRecompute`
 * directly. The job and the manual admin route both call the plain function
 * instead - see the comment on `runFxPricingRecompute`.
 *
 * Deliberately NOT compensated: every write this makes is a reconciliation
 * of PLN-derived prices toward a target, computed fresh from the current
 * PLN price and the current NBP rate - the repair for a partial run is
 * simply another run, and a compensation that "undid" a partial recompute
 * would leave USD/EUR prices further from the target than before the run
 * started, not closer.
 */
export const recomputeFxPricesWorkflow = createWorkflow(
  "recompute-fx-prices",
  () => new WorkflowResponse(recomputeFxPricesStep()),
);
