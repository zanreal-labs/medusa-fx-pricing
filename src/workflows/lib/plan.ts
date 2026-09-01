import { computeForeignAmount } from "../../modules/fx-pricing/lib/compute";
import { decidePriceAction } from "../../modules/fx-pricing/lib/decision";
import type { ExistingDefaultPrice, ManagedPriceRecord } from "../../modules/fx-pricing/lib/decision";

/**
 * Everything the planner needs about one variant to decide what to do for
 * ONE target currency. Built by the step from a `query.graph` read (the
 * variant's own prices) plus a bulk read of this plugin's tracking table -
 * see `src/workflows/steps/recompute-currency-step.ts`. Deliberately plain
 * data, no Medusa types, so `planCurrencyRecompute` below has no I/O and no
 * framework dependency and can be exercised in a test with plain objects.
 */
export interface VariantForPlanning {
  variantId: string;
  productId: string;
  /** The variant's default (no price-list, no price-rule) PLN price amount, or `undefined` if it has none. */
  plnAmount: number | undefined;
  /** The variant's current default price in the target currency, or `null` if none exists. */
  existingDefaultPrice: ExistingDefaultPrice | null;
  /** This plugin's tracked record for the same variant+currency, or `null` if it has never written one. */
  managedRecord: ManagedPriceRecord | null;
  /**
   * `true` when the target currency is priced as a quantity ladder
   * (`min_quantity`/`max_quantity` bounded rows, which carry `rules_count = 0`
   * and so look like default prices to a rules-only test), or when PLN is a
   * ladder with no unbounded row to derive from. Either way there is no single
   * amount to convert and no single row to write, so the variant is skipped
   * under its own counter - see `hasQuantityTieredPrice`.
   */
  quantityTiered: boolean;
}

/** One price this plugin has decided to create or update, still to be written. */
export interface PlannedWrite {
  variantId: string;
  productId: string;
  targetAmount: number;
  /** Present for an update (the existing price row to update in place); absent for a create. */
  priceId?: string;
  sourcePlnAmount: number;
}

/** The outcome of planning one currency's recompute, before anything is written. */
export interface CurrencyPlan {
  writes: PlannedWrite[];
  created: number;
  updated: number;
  /** Already at the target amount and still plugin-managed - nothing to write. */
  unchanged: number;
  skippedManualOverride: number;
  /** No default PLN price, or a PLN amount that could not produce a real target (see `computeForeignAmount`). */
  skippedNoPlnPrice: number;
  /** Priced as a quantity ladder - see `VariantForPlanning.quantityTiered`. */
  skippedQuantityTiered: number;
}

function emptyPlan(): CurrencyPlan {
  return {
    created: 0,
    skippedManualOverride: 0,
    skippedNoPlnPrice: 0,
    skippedQuantityTiered: 0,
    unchanged: 0,
    updated: 0,
    writes: [],
  };
}

/**
 * Decide what to do for every variant, for one currency, at one NBP rate and
 * margin multiplier. Pure: no network, no database, no Medusa container -
 * every decision is made from the plain data already gathered by the step.
 * See `decidePriceAction` for the manual-override rule this delegates to
 * per variant.
 */
export function planCurrencyRecompute(
  variants: readonly VariantForPlanning[],
  nbpRate: number,
  marginMultiplier: number,
): CurrencyPlan {
  const plan = emptyPlan();

  for (const variant of variants) {
    // Checked before the PLN amount, because a tiered variant has no unbounded
    // PLN price either - counting it as "no PLN price" would send an operator
    // looking for a missing price that is not missing.
    if (variant.quantityTiered) {
      plan.skippedQuantityTiered += 1;
      continue;
    }

    if (variant.plnAmount === undefined) {
      plan.skippedNoPlnPrice += 1;
      continue;
    }

    const targetAmount = computeForeignAmount(variant.plnAmount, nbpRate, marginMultiplier);
    if (targetAmount === undefined) {
      plan.skippedNoPlnPrice += 1;
      continue;
    }

    const decision = decidePriceAction({
      existingDefaultPrice: variant.existingDefaultPrice,
      managedRecord: variant.managedRecord,
      targetAmount,
    });

    switch (decision.action) {
      case "create":
        plan.created += 1;
        plan.writes.push({
          productId: variant.productId,
          sourcePlnAmount: variant.plnAmount,
          targetAmount,
          variantId: variant.variantId,
        });
        break;
      case "update":
        plan.updated += 1;
        plan.writes.push({
          priceId: decision.priceId,
          productId: variant.productId,
          sourcePlnAmount: variant.plnAmount,
          targetAmount,
          variantId: variant.variantId,
        });
        break;
      case "noop":
        plan.unchanged += 1;
        break;
      case "skip":
        plan.skippedManualOverride += 1;
        break;
      default: {
        // Exhaustiveness guard - a new PriceDecision variant must be handled above.
        const neverDecision: never = decision;
        throw new Error(`Unhandled price decision: ${JSON.stringify(neverDecision)}`);
      }
    }
  }

  return plan;
}
