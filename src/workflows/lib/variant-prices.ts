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
}

/**
 * The variant's DEFAULT price (no price-list, no price-rule) in one
 * currency, or `undefined` if it has none. This plugin only ever reads or
 * writes the default price - a price scoped by a rule (a region override, a
 * customer-group price, ...) is a different, deliberately-configured price
 * this plugin has no business touching.
 *
 * Currency codes are compared case-insensitively (Medusa stores them
 * lower-case, but this does not assume the caller already normalized).
 */
export function findDefaultPrice(prices: readonly RawPrice[], currencyCode: string): RawPrice | undefined {
  const normalized = currencyCode.trim().toLowerCase();
  return prices.find(
    (price) => price.currency_code?.trim().toLowerCase() === normalized && !price.rules_count,
  );
}

/** Normalizes a currency code list (e.g. the store's `supported_currencies`) to lower-case for comparison. */
export function normalizeCurrencyCodes(codes: readonly string[]): Set<string> {
  return new Set(codes.map((code) => code.trim().toLowerCase()));
}
