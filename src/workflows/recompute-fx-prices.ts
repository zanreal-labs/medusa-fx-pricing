import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { upsertVariantPricesWorkflow } from "@medusajs/medusa/core-flows";
import {
  FX_PRICING_MODULE,
  MARGIN_NOT_CONFIGURED_MESSAGE,
  fetchNbpRate,
  isRateStale,
} from "../modules/fx-pricing";
import type { CurrencyRunSummary, FxSourceCurrency, RunSummary } from "../modules/fx-pricing";
import type FxPricingModuleService from "../modules/fx-pricing/service";
import {
  fetchStoreSupportedCurrencyCodes,
  fetchVariantPricesByIds,
  listCatalogVariants,
} from "./lib/catalog";
import { planCurrencyRecompute } from "./lib/plan";
import type { VariantForPlanning } from "./lib/plan";
import { findDefaultPrice } from "./lib/variant-prices";

const TARGET_CURRENCIES: readonly FxSourceCurrency[] = ["usd", "eur"];

function emptyCurrencySummary(): CurrencyRunSummary {
  return {
    created: 0,
    currencyDisabled: false,
    rateStale: false,
    rateUnavailable: false,
    skippedManualOverride: 0,
    skippedNoPlnPrice: 0,
    unchanged: 0,
    updated: 0,
  };
}

/** A run that did nothing because the toggle is off - the module service's `effectiveEnabled` was `false`. */
function skippedDisabledSummary(): RunSummary {
  return { currencies: {}, ran: false, ranAt: new Date().toISOString() };
}

/**
 * The whole daily/manual recompute, as a plain async function - not a
 * `createStep` body directly, so it can be called straight from the
 * scheduled job and the manual "recompute now" admin route, the same way
 * the sibling `medusa-allegro` plugin's `runOfferDiscovery` is (see that
 * plugin's `src/jobs/allegro-offer-sync.ts` and
 * `src/api/admin/allegro/sync/route.ts` for the precedent). `recomputeFxPricesWorkflow`
 * below wraps this same function in a one-step workflow for callers that
 * want it composed into a larger workflow.
 *
 * Gated by the toggle INSIDE this function (not by each caller separately),
 * so the job and the manual action can never disagree about whether they are
 * allowed to run - both call this and both get the same
 * `{ ran: false }` when the plugin is off, and both log/report from the same
 * `RunSummary` shape.
 */
export async function runFxPricingRecompute(container: MedusaContainer): Promise<RunSummary> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const fxPricing: FxPricingModuleService = container.resolve(FX_PRICING_MODULE);

  const runtimeOptions = await fxPricing.getResolvedRuntimeOptions();
  if (!runtimeOptions.effectiveEnabled) {
    const reason = runtimeOptions.forceDisabled
      ? "disabled (FX_PRICING_DISABLED is set)"
      : "disabled (Settings > FX pricing)";
    logger.info(`[fx-pricing] skipped (${reason})`);
    return skippedDisabledSummary();
  }

  const summary: RunSummary = { currencies: {}, ran: true, ranAt: new Date().toISOString() };

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

    const [supportedCurrencies, catalogVariants] = await Promise.all([
      fetchStoreSupportedCurrencyCodes(container),
      listCatalogVariants(container),
    ]);

    for (const currency of TARGET_CURRENCIES) {
      const currencySummary = emptyCurrencySummary();
      summary.currencies[currency] = currencySummary;

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
        logger.warn(
          `[fx-pricing] skipped ${currency.toUpperCase()} (NBP rate fetch failed: ${
            error instanceof Error ? error.message : String(error)
          })`,
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

      const variantsWithPln = catalogVariants
        .map((variant): VariantForPlanning => {
          const plnPrice = findDefaultPrice(variant.prices, "pln");
          const existingPrice = findDefaultPrice(variant.prices, currency);
          return {
            existingDefaultPrice: existingPrice ? { amount: existingPrice.amount, id: existingPrice.id } : null,
            managedRecord: null,
            plnAmount: plnPrice?.amount,
            productId: variant.productId,
            variantId: variant.id,
          };
        })
        .filter((variant) => variant.plnAmount !== undefined);

      if (variantsWithPln.length === 0) {
        continue;
      }

      const managedRecords = await fxPricing.getManagedPricesByVariantIds(
        variantsWithPln.map((variant) => variant.variantId),
        currency,
      );
      for (const variant of variantsWithPln) {
        const record = managedRecords.get(variant.variantId);
        variant.managedRecord = record ? { amount: record.amount, priceId: record.price_id } : null;
      }

      const plan = planCurrencyRecompute(variantsWithPln, rate.mid, marginMultiplier);
      currencySummary.created = plan.created;
      currencySummary.updated = plan.updated;
      currencySummary.unchanged = plan.unchanged;
      currencySummary.skippedManualOverride = plan.skippedManualOverride;
      currencySummary.skippedNoPlnPrice = plan.skippedNoPlnPrice;

      if (plan.writes.length > 0) {
        await upsertVariantPricesWorkflow(container).run({
          input: {
            previousVariantIds: [],
            variantPrices: plan.writes.map((write) => ({
              prices: [
                write.priceId
                  ? { amount: write.targetAmount, id: write.priceId }
                  : { amount: write.targetAmount, currency_code: currency },
              ],
              product_id: write.productId,
              variant_id: write.variantId,
            })),
          },
        });

        // Re-read the touched variants rather than trusting the workflow's
        // own return shape - see the module comment on `FxManagedPrice` for
        // why the tracking row needs the AUTHORITATIVE price id/amount.
        const refreshed = await fetchVariantPricesByIds(
          container,
          plan.writes.map((write) => write.variantId),
        );
        for (const write of plan.writes) {
          const refreshedPrices = refreshed.get(write.variantId) ?? [];
          const writtenPrice = findDefaultPrice(refreshedPrices, currency);
          if (!writtenPrice) {
            logger.warn(
              `[fx-pricing] wrote a ${currency.toUpperCase()} price for variant ${write.variantId} but could not read it back - skipping the ownership record for it this run.`,
            );
            continue;
          }
          await fxPricing.recordManagedPrice({
            amount: writtenPrice.amount,
            currencyCode: currency,
            marginMultiplier,
            nbpRate: rate.mid,
            priceId: writtenPrice.id,
            sourcePlnAmount: write.sourcePlnAmount,
            variantId: write.variantId,
          });
        }
      }

      logger.info(
        `[fx-pricing] ${currency.toUpperCase()}: rate=${rate.mid} (${rate.effectiveDate}) created=${plan.created} updated=${plan.updated} unchanged=${plan.unchanged} skippedManualOverride=${plan.skippedManualOverride} skippedNoPlnPrice=${plan.skippedNoPlnPrice}`,
      );
    }
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
    logger.error(`[fx-pricing] recompute run failed: ${summary.error}`);
  }

  try {
    await fxPricing.recordRunSummary(summary);
  } catch (error) {
    logger.warn(
      `[fx-pricing] recompute finished but the run summary could not be persisted: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return summary;
}

const recomputeFxPricesStep = createStep(
  "recompute-fx-prices",
  async (_input: void, { container }: { container: MedusaContainer }) =>
    new StepResponse(await runFxPricingRecompute(container)),
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
