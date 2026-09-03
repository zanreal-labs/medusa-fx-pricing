import type { MedusaContainer } from "@medusajs/framework/types";
import { FX_PRICING_MODULE, fetchNbpRate, isRateStale } from "../modules/fx-pricing";
import type { FxSourceCurrency } from "../modules/fx-pricing";
import { toNetPlnAmount } from "../modules/fx-pricing/lib/compute";
import type { VatAdjustment } from "../modules/fx-pricing/lib/compute";
import type FxPricingModuleService from "../modules/fx-pricing/service";
import { fetchStoreSupportedCurrencyCodes, listCatalogVariants, listCatalogVariantsByIds } from "./lib/catalog";
import { planCurrencyRecompute } from "./lib/plan";
import type { VariantForPlanning } from "./lib/plan";
import { findDefaultPrice, hasQuantityTieredPrice } from "./lib/variant-prices";

const TARGET_CURRENCIES: readonly FxSourceCurrency[] = ["usd", "eur"];

/**
 * One price this run would create or update, as `runFxPricingRecompute`
 * would decide it - see `planCurrencyRecompute`. Nothing here is written;
 * see `previewFxPricingRecompute`.
 */
export interface FxPricingPreviewRow {
  variantId: string;
  productId: string;
  /** The variant's default PLN price as stored - gross, when `vatAdjustment.sourceIncludesVat` is true. */
  plnAmount: number;
  /**
   * `plnAmount` after the VAT strip actually used for the conversion below -
   * equal to `plnAmount` when `vatAdjustment.sourceIncludesVat` is `false`.
   * Shown so the report can be read as "current PLN -> net base -> proposed
   * EUR/USD" end to end, the same three numbers `computeForeignAmount` itself
   * combines - see AI-655.
   */
  netPlnBase: number;
  /** The variant's current default price in this currency, or `null` if it has none yet. */
  currentAmount: number | null;
  /** What this run would write. */
  proposedAmount: number;
  action: "create" | "update";
}

/** One target currency's preview - what would change, and the counts for what would not. */
export interface FxPricingCurrencyPreview {
  currency: FxSourceCurrency;
  /** Currency not enabled in the store's `supported_currencies` - nothing was read for it. */
  currencyDisabled: boolean;
  /** The NBP rate could not be fetched/parsed - nothing was read for it. */
  rateUnavailable: boolean;
  /** The fetched rate is older than the staleness tolerance - a real run would skip this currency. */
  rateStale: boolean;
  rate?: number;
  rateEffectiveDate?: string;
  /** Every variant+currency this run would create or update - see `FxPricingPreviewRow`. */
  rows: FxPricingPreviewRow[];
  /** Already at the target amount and still plugin-managed - counted, not listed. */
  unchanged: number;
  /** A manually-set or manually-edited price this run would leave alone - see `decidePriceAction`. */
  skippedManualOverride: number;
  /** No default PLN price, or a PLN amount that cannot produce a real target. */
  skippedNoPlnPrice: number;
  /** Priced as a quantity ladder - see `VariantForPlanning.quantityTiered`. */
  skippedQuantityTiered: number;
}

export interface FxPricingPreviewResult {
  generatedAt: string;
  /** How many variants this preview was narrowed to, or `null` for a full catalog pass. */
  scopedVariantCount: number | null;
  /** `null` when no margin is configured anywhere - a real run would refuse, and so does this preview (every currency below is empty). */
  marginMultiplier: number | null;
  /** The VAT handling this preview (and a real run) would use - see `FxPricingModuleOptions.sourcePriceIncludesVat`. */
  vatAdjustment: VatAdjustment;
  currencies: FxPricingCurrencyPreview[];
}

export interface FxPricingPreviewOptions {
  /** Preview only these variant ids - see `FxPricingRecomputeOptions.variantIds` for the same narrowing on a real run. */
  variantIds?: readonly string[];
}

function emptyCurrencyPreview(
  currency: FxSourceCurrency,
  overrides: Partial<FxPricingCurrencyPreview> = {},
): FxPricingCurrencyPreview {
  return {
    currency,
    currencyDisabled: false,
    rateStale: false,
    rateUnavailable: false,
    rows: [],
    skippedManualOverride: 0,
    skippedNoPlnPrice: 0,
    skippedQuantityTiered: 0,
    unchanged: 0,
    ...overrides,
  };
}

/**
 * The read-only twin of `runFxPricingRecompute`: fetches the same catalog,
 * the same live NBP rates, and runs the exact same `planCurrencyRecompute`
 * this plugin uses to decide what to write - but never resolves a price
 * writer, never writes a price, and never records a run summary or a
 * managed-price stamp. Safe to run against production at any time, whether
 * or not the plugin is armed.
 *
 * Exists for the question a `RunSummary` can only answer after the fact:
 * "what would change?" - the current PLN price, the net base it would
 * actually be converted from (see AI-655 and `VatAdjustment`), and the
 * resulting EUR/USD amount, side by side, before anything is armed or run
 * for real. See the README's "Dry run" section for a ready-to-paste
 * `medusa exec` script that prints this as a table.
 *
 * Deliberately not unit tested, the same as `runFxPricingRecompute` itself -
 * see the README's "What is unit tested, and what is not": this is thin I/O
 * glue around `planCurrencyRecompute`, which already has exhaustive
 * framework-free tests of its own.
 */
export async function previewFxPricingRecompute(
  container: MedusaContainer,
  options: FxPricingPreviewOptions = {},
): Promise<FxPricingPreviewResult> {
  const fxPricing: FxPricingModuleService = container.resolve(FX_PRICING_MODULE);
  const scopedVariantIds = options.variantIds;
  const runtimeOptions = await fxPricing.getResolvedRuntimeOptions();
  const vatAdjustment: VatAdjustment = {
    sourceIncludesVat: runtimeOptions.sourcePriceIncludesVat,
    vatRate: runtimeOptions.vatRate,
  };

  const result: FxPricingPreviewResult = {
    currencies: [],
    generatedAt: new Date().toISOString(),
    marginMultiplier: runtimeOptions.marginMultiplier,
    scopedVariantCount: scopedVariantIds?.length ?? null,
    vatAdjustment,
  };

  // No margin configured anywhere: a real run refuses outright (see
  // `MARGIN_NOT_CONFIGURED_MESSAGE`), so this preview reports the same thing
  // it would report after the fact - nothing would be written - rather than
  // computing a target amount with a guessed margin.
  if (runtimeOptions.marginMultiplier === null) {
    return result;
  }
  const marginMultiplier = runtimeOptions.marginMultiplier;

  // Narrowed to nothing - see `FxPricingRecomputeOptions.variantIds` for why
  // this is not the same as "the whole catalog".
  if (scopedVariantIds !== undefined && scopedVariantIds.length === 0) {
    return result;
  }

  const [supportedCurrencies, catalogVariants] = await Promise.all([
    fetchStoreSupportedCurrencyCodes(container),
    scopedVariantIds === undefined
      ? listCatalogVariants(container)
      : listCatalogVariantsByIds(container, scopedVariantIds),
  ]);

  for (const currency of TARGET_CURRENCIES) {
    if (!supportedCurrencies.has(currency)) {
      result.currencies.push(emptyCurrencyPreview(currency, { currencyDisabled: true }));
      continue;
    }

    let rate: Awaited<ReturnType<typeof fetchNbpRate>>;
    try {
      rate = await fetchNbpRate(currency);
    } catch {
      result.currencies.push(emptyCurrencyPreview(currency, { rateUnavailable: true }));
      continue;
    }

    const stale = isRateStale(rate, new Date(), runtimeOptions.stalenessToleranceHours);

    const plannableVariants = catalogVariants.map((variant): VariantForPlanning => {
      const plnPrice = findDefaultPrice(variant.prices, "pln");
      const existingPrice = findDefaultPrice(variant.prices, currency);
      return {
        existingDefaultPrice: existingPrice ? { amount: existingPrice.amount, id: existingPrice.id } : null,
        managedRecord: null,
        plnAmount: plnPrice?.amount,
        productId: variant.productId,
        quantityTiered:
          hasQuantityTieredPrice(variant.prices, currency) ||
          (plnPrice === undefined && hasQuantityTieredPrice(variant.prices, "pln")),
        variantId: variant.id,
      };
    });

    const candidates = plannableVariants.filter(
      (variant) => !variant.quantityTiered && variant.plnAmount !== undefined,
    );
    // Same split `runFxPricingRecompute` uses: variants filtered out above
    // (never reach the planner at all) plus whatever the planner itself
    // additionally skips (a defined-but-invalid PLN amount, e.g. zero) - see
    // `computeForeignAmount`.
    const skippedQuantityTieredOuter = plannableVariants.filter((variant) => variant.quantityTiered).length;
    const skippedNoPlnPriceOuter = plannableVariants.length - candidates.length - skippedQuantityTieredOuter;
    const managedRecords = await fxPricing.getManagedPricesByVariantIds(
      candidates.map((variant) => variant.variantId),
      currency,
    );
    for (const variant of candidates) {
      const record = managedRecords.get(variant.variantId);
      variant.managedRecord = record ? { amount: record.amount, priceId: record.price_id } : null;
    }

    const plan = planCurrencyRecompute(candidates, rate.mid, marginMultiplier, vatAdjustment);

    const rows: FxPricingPreviewRow[] = plan.writes.map((write) => ({
      action: write.priceId === undefined ? "create" : "update",
      currentAmount:
        candidates.find((variant) => variant.variantId === write.variantId)?.existingDefaultPrice?.amount ?? null,
      netPlnBase: toNetPlnAmount(write.sourcePlnAmount, vatAdjustment) ?? write.sourcePlnAmount,
      plnAmount: write.sourcePlnAmount,
      productId: write.productId,
      proposedAmount: write.targetAmount,
      variantId: write.variantId,
    }));

    result.currencies.push({
      currency,
      currencyDisabled: false,
      rate: rate.mid,
      rateEffectiveDate: rate.effectiveDate,
      rateStale: stale,
      rateUnavailable: false,
      rows,
      skippedManualOverride: plan.skippedManualOverride,
      skippedNoPlnPrice: skippedNoPlnPriceOuter + plan.skippedNoPlnPrice,
      skippedQuantityTiered: skippedQuantityTieredOuter + plan.skippedQuantityTiered,
      unchanged: plan.unchanged,
    });
  }

  return result;
}

/**
 * Render a `FxPricingPreviewResult` as a plain-text report, in the shape a
 * `medusa exec` script prints to the console. Pure and framework-free (plain
 * data in, a string out - no container, no I/O), so unlike
 * `previewFxPricingRecompute` above it IS unit tested directly from fixture
 * data - see `src/workflows/__tests__/preview-fx-prices.test.ts`.
 */
export function formatFxPricingPreview(result: FxPricingPreviewResult): string {
  const lines: string[] = [];
  lines.push(`[fx-pricing] dry run at ${result.generatedAt}`);
  lines.push(
    `  marginMultiplier=${result.marginMultiplier ?? "NOT CONFIGURED"}` +
      `  sourcePriceIncludesVat=${result.vatAdjustment.sourceIncludesVat}` +
      `  vatRate=${result.vatAdjustment.vatRate}` +
      `  scopedVariantCount=${result.scopedVariantCount ?? "ALL"}`,
  );

  if (result.marginMultiplier === null) {
    lines.push(
      "  NOTE: no margin multiplier is configured, so a real run would refuse and write nothing. Nothing was previewed.",
    );
    return lines.join("\n");
  }

  for (const currency of result.currencies) {
    lines.push(`\n=== ${currency.currency.toUpperCase()} ===`);
    if (currency.currencyDisabled) {
      lines.push("  skipped: not enabled in the store's supported currencies");
      continue;
    }
    if (currency.rateUnavailable) {
      lines.push("  skipped: NBP rate could not be fetched");
      continue;
    }
    lines.push(
      `  rate=${currency.rate} (${currency.rateEffectiveDate})${currency.rateStale ? " STALE - a real run would skip this currency" : ""}`,
    );
    lines.push(
      `  would create/update: ${currency.rows.length}` +
        `  unchanged: ${currency.unchanged}` +
        `  manualOverride: ${currency.skippedManualOverride}` +
        `  noPlnPrice: ${currency.skippedNoPlnPrice}` +
        `  quantityTiered: ${currency.skippedQuantityTiered}`,
    );
    for (const row of currency.rows) {
      const vatNote = row.netPlnBase === row.plnAmount ? "" : ` (net base ${row.netPlnBase.toFixed(2)})`;
      lines.push(
        `    ${row.action.padEnd(6)} variant=${row.variantId} PLN ${row.plnAmount.toFixed(2)}${vatNote}` +
          ` -> ${currency.currency.toUpperCase()} ${row.proposedAmount.toFixed(2)}` +
          ` (current: ${row.currentAmount === null ? "none" : row.currentAmount.toFixed(2)})`,
      );
    }
  }

  return lines.join("\n");
}
