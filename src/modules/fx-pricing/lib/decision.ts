/**
 * The "manual overrides are sacred" decision, as a pure function.
 *
 * Medusa v2's `Price` (money amount) row has no `metadata` column, and its
 * `price_rules` exist to scope a price to a pricing CONTEXT (region,
 * customer group, quantity break) - attaching a marker rule such as
 * `{ fx_pricing_managed: "true" }` would make the price only match a
 * checkout context that happens to supply that same attribute, which is not
 * what a marker is supposed to do and would make the price invisible at
 * checkout. Neither mechanism can safely carry an ownership marker, so this
 * plugin tracks it itself: `FxManagedPrice` (see the model) records, per
 * variant and currency, the exact `price_id` and `amount` this plugin last
 * wrote. That is an optimistic-concurrency stamp, not a flag stored on the
 * price - and it is what this function reads to decide what is safe to do.
 *
 * The rule, in one sentence: a currency price this plugin has never written
 * is left alone forever, and a currency price this plugin DID write is only
 * still "ours" to touch if it is still exactly what we left it as (same
 * price id, same amount) - the moment either differs, somebody else acted on
 * it and it stays hands-off permanently, until it is deleted entirely (which
 * clears `existingDefaultPrice` and lets this plugin recreate it next run).
 */

/** The variant's current default (no price-list, no price-rule) price in one currency, if any. */
export interface ExistingDefaultPrice {
  id: string;
  amount: number;
}

/** This plugin's own record of the last price it wrote for this variant+currency, if any. */
export interface ManagedPriceRecord {
  priceId: string;
  amount: number;
}

export type PriceDecision =
  | { action: "create" }
  | { action: "update"; priceId: string }
  | { action: "noop"; priceId: string }
  | { action: "skip"; reason: "manual-override" };

export interface DecidePriceActionInput {
  /** The variant's current default price in the target currency, or `null` if none exists. */
  existingDefaultPrice: ExistingDefaultPrice | null;
  /** This plugin's tracked record for the same variant+currency, or `null` if it has never written one. */
  managedRecord: ManagedPriceRecord | null;
  /** The amount this run has just computed for the variant in the target currency. */
  targetAmount: number;
}

export function decidePriceAction(input: DecidePriceActionInput): PriceDecision {
  const { existingDefaultPrice, managedRecord, targetAmount } = input;

  // No price at all in this currency yet - nothing to protect. This is also
  // the reclaim path: deleting a manually-set price (or a price this plugin
  // once owned and lost track of) makes it eligible for this plugin to
  // create again on the very next run.
  if (existingDefaultPrice === null) {
    return { action: "create" };
  }

  // A price exists, but this plugin has never recorded writing one for this
  // variant+currency - it must have been set some other way (initial
  // catalog import, a manual admin edit before this plugin was installed).
  // Sacred: leave it alone.
  if (managedRecord === null) {
    return { action: "skip", reason: "manual-override" };
  }

  // A price exists AND this plugin has a record for it, but the record
  // points at a different price row (that row was deleted and replaced,
  // most likely by a manual edit that happened to land under a new id).
  // The current row is not the one we wrote - sacred.
  if (managedRecord.priceId !== existingDefaultPrice.id) {
    return { action: "skip", reason: "manual-override" };
  }

  // Same price id, but the amount no longer matches what this plugin last
  // wrote - someone edited the amount directly without changing the row's
  // id (exactly what an in-place admin price edit does). Sacred.
  if (managedRecord.amount !== existingDefaultPrice.amount) {
    return { action: "skip", reason: "manual-override" };
  }

  // The live price is still exactly what this plugin left it as - safe to
  // manage. Only actually write if the target has moved; otherwise this run
  // has nothing to do for this variant+currency.
  if (existingDefaultPrice.amount === targetAmount) {
    return { action: "noop", priceId: existingDefaultPrice.id };
  }
  return { action: "update", priceId: existingDefaultPrice.id };
}
