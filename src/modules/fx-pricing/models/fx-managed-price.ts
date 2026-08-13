import { model } from "@medusajs/framework/utils";

/**
 * The ownership stamp behind "manual overrides are sacred" - see
 * `src/modules/fx-pricing/lib/decision.ts` for the full reasoning on why
 * this side table exists instead of a marker on the `Price` row itself
 * (Medusa v2's `Price`/money-amount model has no `metadata` column, and its
 * `price_rules` scope a price to a pricing CONTEXT, not an ownership flag -
 * neither can safely carry a marker).
 *
 * One row per (variant, currency) that this plugin has ever priced,
 * recording the exact `price_id` and `amount` it last wrote. On every
 * subsequent run, the live price is compared against this row: if the id and
 * amount still match, the price is still exactly what this plugin left it as
 * and is safe to update again; the moment either differs, something else
 * wrote to it and it is left alone from then on - see `decidePriceAction`.
 *
 * There is no unique database constraint on `(variant_id, currency_code)` in
 * the migration - deliberately, to keep the write path a plain
 * create-or-update through the service rather than a database-level upsert,
 * matching how `ProductCostsSettings`/`AllegroSettings` in the sibling
 * plugins are also read-then-written rather than upserted at the SQL layer.
 * The service is the only writer and always reads-before-writing, so a
 * duplicate row per variant+currency should not occur in practice; if one
 * ever does, the service's read picks the most recently updated row.
 */
const FxManagedPrice = model.define("fx_managed_price", {
  /** The amount (in the target currency's smallest-unit-free decimal form) this plugin last wrote. */
  amount: model.bigNumber(),
  /** When this record was last written - i.e. when this plugin last computed and wrote this price. */
  computed_at: model.dateTime(),
  /** `"usd"` or `"eur"`. Lower-case, matching Medusa's own `currency_code` convention. */
  currency_code: model.text(),
  id: model.id({ prefix: "fxprc" }).primaryKey(),
  /** The margin multiplier used to compute `amount`, kept for audit/debugging. */
  margin_multiplier: model.bigNumber(),
  /** The NBP mid rate used to compute `amount`, kept for audit/debugging. */
  nbp_rate: model.bigNumber(),
  /** The `Price` (money amount) row id this plugin wrote. The ownership check's primary key. */
  price_id: model.text(),
  /** The PLN default price's amount this was computed from, kept for audit/debugging. */
  source_pln_amount: model.bigNumber(),
  /** The Medusa product variant id this price belongs to. Not a module link - see the model comment on why this is a plain tracking table, not a cross-module read surface. Indexed: the recompute step's bulk read filters by a batch of variant ids. */
  variant_id: model.text().index(),
});

export default FxManagedPrice;
