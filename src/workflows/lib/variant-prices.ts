/**
 * Small, framework-free helpers for reading a variant's prices as returned
 * by `query.graph({ entity: "product_variant", fields: ["prices.*", ...] })`
 * - shared by the step that builds a `VariantForPlanning[]` and by tests.
 */

export interface RawPrice {
  id: string;
  amount: number;
  currency_code: string;
  /** `0` (or absent) marks the price as the DEFAULT one for its currency - no price-list, no price-rule scoping it to a region/customer group/quantity break. */
  rules_count?: number | null;
  /**
   * The lower bound of a quantity break, or `null`/absent for an unbounded
   * price. Medusa stores a quantity ladder as `min_quantity`/`max_quantity`
   * COLUMNS on `price`, not as `price_rules`, so `rules_count` stays `0` on a
   * tiered row and cannot be used to tell one apart from a base price - see
   * `isDefaultPrice`.
   */
  min_quantity?: number | null;
  /** The upper bound of a quantity break. See `min_quantity`. */
  max_quantity?: number | null;
}

/**
 * Whether a price row is the variant's plain default price in its currency:
 * no price-rule scoping it to a region/customer group, and no quantity bound.
 *
 * The quantity half of that test is not theoretical. Production carries nine
 * variants priced as a six-step ladder (`min_quantity` 1/10/15/25/50/100 in
 * PLN, EUR and USD each) alongside sixty-one variants with a single unbounded
 * PLN price. Every row in that ladder has `rules_count = 0`, so a rules-only
 * test picks whichever tier the query happened to return first and calls it the
 * base price - which would have this plugin derive a USD price from a
 * hundred-seat PLN rate, or overwrite a quantity break with a single-unit
 * amount. Neither is a price anybody chose.
 */
export function isDefaultPrice(price: RawPrice): boolean {
  return !price.rules_count && price.min_quantity == null && price.max_quantity == null;
}

/**
 * The variant's DEFAULT price (no price-list, no price-rule, no quantity
 * bound) in one currency, or `undefined` if it has none. This plugin only ever
 * reads or writes the default price - a price scoped by a rule (a region
 * override, a customer-group price, ...) or by a quantity break is a
 * different, deliberately-configured price this plugin has no business
 * touching.
 *
 * Currency codes are compared case-insensitively (Medusa stores them
 * lower-case, but this does not assume the caller already normalized).
 */
export function findDefaultPrice(prices: readonly RawPrice[], currencyCode: string): RawPrice | undefined {
  const normalized = currencyCode.trim().toLowerCase();
  return prices.find(
    (price) => price.currency_code?.trim().toLowerCase() === normalized && isDefaultPrice(price),
  );
}

/**
 * Whether the variant carries any quantity-bounded price in this currency.
 *
 * Used to tell "this variant has no price here yet, create one" apart from
 * "this variant is priced as a quantity ladder, so a single default price is
 * not the shape its prices are in". The first is a create; the second is a
 * skip that has to be reported under its own counter, because an operator
 * reading `skippedManualOverride` would go looking for a manual edit that
 * never happened.
 */
export function hasQuantityTieredPrice(prices: readonly RawPrice[], currencyCode: string): boolean {
  const normalized = currencyCode.trim().toLowerCase();
  return prices.some(
    (price) =>
      price.currency_code?.trim().toLowerCase() === normalized &&
      !price.rules_count &&
      (price.min_quantity != null || price.max_quantity != null),
  );
}

/** Normalizes a currency code list (e.g. the store's `supported_currencies`) to lower-case for comparison. */
export function normalizeCurrencyCodes(codes: readonly string[]): Set<string> {
  return new Set(codes.map((code) => code.trim().toLowerCase()));
}
