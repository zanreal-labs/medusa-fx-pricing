import { describe, expect, it } from "vitest";
import { findDefaultPrice, normalizeCurrencyCodes } from "../variant-prices";
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
