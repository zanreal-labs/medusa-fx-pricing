import type { MedusaContainer } from "@medusajs/framework/types";
import { MedusaError, Modules } from "@medusajs/framework/utils";

/**
 * Writing ONE currency's default price on a variant, without disturbing
 * anything else on that variant's price set.
 *
 * ## Why this file exists instead of `upsertVariantPricesWorkflow`
 *
 * This plugin used to write through core's `upsertVariantPricesWorkflow` with
 * `previousVariantIds: []`. That call could never succeed, for any variant,
 * ever - which is why `fx_managed_price` was still empty after a run that
 * reported creating 61 prices.
 *
 * The workflow splits its input on `previousVariantIds`
 * (`@medusajs/core-flows/dist/product/workflows/upsert-variant-prices.js`):
 *
 * - a variant **in** that list is an "existing" one: its price set is looked up
 *   through the `product_variant_price_set` link and handed to
 *   `updatePriceSetsStep`;
 * - a variant **not** in it is a "new" one: a brand-new `PriceSet` is created
 *   for it and linked to the variant with `createVariantPricingLinkStep`.
 *
 * Passing `[]` puts every variant in the second group. But the
 * `ProductVariantPriceSet` link declares `hasMany` on neither side, so
 * `RemoteLink.create` validates the pairing as one-to-one and throws
 * `MedusaError(INVALID_DATA, "Cannot create multiple links between
 * 'productService' and 'pricingService'")` the moment the variant already has a
 * price set - which every variant this plugin would ever price does, because it
 * only prices variants that already have a PLN price. The link step is the last
 * step in that workflow, so the created price sets were then compensated away
 * by a hard delete, leaving no `price` row, no `price_set` row, and no trace in
 * the database at all.
 *
 * The other branch is not the fix either. `updatePriceSets` REPLACES a price
 * set's prices: `updatePriceSets_` lists the set's existing prices with
 * `price_list_id: null` and deletes every one whose id is not in the incoming
 * array (`@medusajs/pricing/dist/services/pricing-module.js`). Handing it one
 * USD price would delete the variant's PLN price, its EUR price, and any
 * quantity-break row on the same set. It is the right primitive for the admin's
 * "here is the variant's complete price grid" save, and the wrong one for
 * "move one currency's amount".
 *
 * So this plugin writes through the two pricing-module primitives that operate
 * on a single price: `addPrices`, which appends to an existing price set, and
 * `updatePrices`, which moves one price row by id. The sibling
 * `srp-store-price` script in `zanreal-labs/medusa` reached the same two
 * primitives for the same reason; this is that pattern, not a new one.
 *
 * ## Why they are duck-typed
 *
 * `addPrices` and `updatePrices` are generated onto the pricing module service
 * by `MedusaService` from its `Price` model, so they exist on the instance but
 * are not declared on `IPricingModuleService`. `resolvePriceWriter` asserts
 * they are both really there and refuses the run with a message naming the
 * problem if they are not, rather than discovering it as a `TypeError` halfway
 * through a currency.
 */

/** The two single-price write primitives, as they exist on the pricing module service. */
export interface PriceWriter {
  /** Append prices to an existing price set, leaving everything already on it alone. */
  addPrices: (
    data: { priceSetId: string; prices: { amount: number; currency_code: string }[] }[],
  ) => Promise<unknown>;
  /** Move one existing price row's amount, by id. */
  updatePrices: (data: { amount: number; id: string }[]) => Promise<unknown>;
}

export const PRICE_WRITER_UNAVAILABLE_MESSAGE =
  "The pricing module does not expose both `addPrices` and `updatePrices`. They are generated from the module's `Price` model, so this means the module's shape changed - stop and check before writing prices another way. Neither `updatePriceSets` (which replaces a price set's whole price list) nor `upsertVariantPricesWorkflow` (which creates a second price set) is a safe substitute.";

/**
 * The pricing module service, checked for the two methods this plugin writes
 * through. Throws rather than returning a partially usable object: a run that
 * cannot write prices should refuse at the top, not fail per variant.
 */
export function resolvePriceWriter(container: MedusaContainer): PriceWriter {
  const pricing = container.resolve(Modules.PRICING) as unknown as Partial<PriceWriter>;
  if (typeof pricing?.addPrices !== "function" || typeof pricing?.updatePrices !== "function") {
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, PRICE_WRITER_UNAVAILABLE_MESSAGE);
  }
  return pricing as PriceWriter;
}
