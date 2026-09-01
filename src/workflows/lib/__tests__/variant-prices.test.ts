import { describe, expect, it } from "vitest";
import { findDefaultPrice, hasQuantityTieredPrice, normalizeCurrencyCodes } from "../variant-prices";
import type { RawPrice } from "../variant-prices";

describe("findDefaultPrice", () => {
  const prices: RawPrice[] = [
    { amount: 100, currency_code: "pln", id: "price_pln", rules_count: 0 },
    { amount: 27.5, currency_code: "usd", id: "price_usd_default", rules_count: 0 },
    { amount: 30, currency_code: "usd", id: "price_usd_region_rule", rules_count: 1 },
    { amount: 90, currency_code: "eur", id: "price_eur_default" }, // rules_count absent
  ];

  it("finds the default (no price-rule) price for a currency", () => {
    expect(findDefaultPrice(prices, "usd")).toEqual(prices[1]);
  });

  it("ignores a price scoped by a price rule", () => {
    const result = findDefaultPrice(prices, "usd");
    expect(result?.id).not.toBe("price_usd_region_rule");
  });

  it("treats a missing rules_count the same as zero (still a default price)", () => {
    expect(findDefaultPrice(prices, "eur")).toEqual(prices[3]);
  });

  it("is case-insensitive on the currency code", () => {
    expect(findDefaultPrice(prices, "USD")).toEqual(prices[1]);
    expect(findDefaultPrice(prices, "Pln")).toEqual(prices[0]);
  });

  it("returns undefined when no default price exists in that currency", () => {
    expect(findDefaultPrice(prices, "gbp")).toBeUndefined();
  });

  it("returns undefined when the only price in that currency is rule-scoped", () => {
    const onlyRuled: RawPrice[] = [
      { amount: 30, currency_code: "usd", id: "price_usd_region_rule", rules_count: 2 },
    ];
    expect(findDefaultPrice(onlyRuled, "usd")).toBeUndefined();
  });

  /**
   * Production carries nine variants priced as a six-step quantity ladder in
   * PLN, EUR and USD. Every row in it has `rules_count = 0`, so a rules-only
   * test would return the first tier as if it were the base price.
   */
  it("does not mistake a quantity-break row for the default price", () => {
    const ladder: RawPrice[] = [
      { amount: 100, currency_code: "pln", id: "price_tier_1", min_quantity: 1, rules_count: 0 },
      { amount: 90, currency_code: "pln", id: "price_tier_10", min_quantity: 10, rules_count: 0 },
      { amount: 80, currency_code: "pln", id: "price_tier_100", min_quantity: 100, rules_count: 0 },
    ];
    expect(findDefaultPrice(ladder, "pln")).toBeUndefined();
  });

  it("ignores a max_quantity-bounded row too", () => {
    const bounded: RawPrice[] = [
      { amount: 100, currency_code: "usd", id: "price_capped", max_quantity: 9, rules_count: 0 },
    ];
    expect(findDefaultPrice(bounded, "usd")).toBeUndefined();
  });

  it("still finds an unbounded price sitting alongside a ladder", () => {
    const mixed: RawPrice[] = [
      { amount: 90, currency_code: "pln", id: "price_tier_10", min_quantity: 10, rules_count: 0 },
      { amount: 100, currency_code: "pln", id: "price_base", rules_count: 0 },
    ];
    expect(findDefaultPrice(mixed, "pln")?.id).toBe("price_base");
  });
});

describe("hasQuantityTieredPrice", () => {
  const ladder: RawPrice[] = [
    { amount: 100, currency_code: "pln", id: "price_tier_1", min_quantity: 1, rules_count: 0 },
    { amount: 27.5, currency_code: "usd", id: "price_usd", rules_count: 0 },
  ];

  it("is true for a currency priced with a quantity bound", () => {
    expect(hasQuantityTieredPrice(ladder, "pln")).toBe(true);
  });

  it("is false for a currency with only an unbounded price", () => {
    expect(hasQuantityTieredPrice(ladder, "usd")).toBe(false);
  });

  it("is false for a currency with no price at all", () => {
    expect(hasQuantityTieredPrice(ladder, "eur")).toBe(false);
  });

  it("ignores a rule-scoped price, which is a different kind of skip", () => {
    const ruled: RawPrice[] = [
      { amount: 30, currency_code: "usd", id: "price_ruled", min_quantity: 5, rules_count: 1 },
    ];
    expect(hasQuantityTieredPrice(ruled, "usd")).toBe(false);
  });
});

describe("normalizeCurrencyCodes", () => {
  it("lower-cases and de-duplicates", () => {
    const result = normalizeCurrencyCodes(["PLN", "usd", "Usd", "eur"]);
    expect(result).toEqual(new Set(["pln", "usd", "eur"]));
  });

  it("trims whitespace", () => {
    expect(normalizeCurrencyCodes([" USD "])).toEqual(new Set(["usd"]));
  });
});
