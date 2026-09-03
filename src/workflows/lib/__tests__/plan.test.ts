import { describe, expect, it } from "vitest";
import { planCurrencyRecompute } from "../plan";
import type { VariantForPlanning } from "../plan";

const RATE = 4; // 1 USD = 4 PLN, for round numbers
const MARGIN = 1.1;

function variant(overrides: Partial<VariantForPlanning>): VariantForPlanning {
  return {
    existingDefaultPrice: null,
    managedRecord: null,
    plnAmount: 100,
    productId: "prod_1",
    quantityTiered: false,
    variantId: "variant_1",
    ...overrides,
  };
}

describe("planCurrencyRecompute", () => {
  it("creates a price for a variant with a PLN price and none yet in the target currency", () => {
    const plan = planCurrencyRecompute([variant({})], RATE, MARGIN);
    expect(plan.created).toBe(1);
    expect(plan.writes).toEqual([
      { productId: "prod_1", sourcePlnAmount: 100, targetAmount: 27.5, variantId: "variant_1" },
    ]);
  });

  it("skips a variant with no PLN price at all", () => {
    const plan = planCurrencyRecompute([variant({ plnAmount: undefined })], RATE, MARGIN);
    expect(plan.skippedNoPlnPrice).toBe(1);
    expect(plan.writes).toHaveLength(0);
  });

  it("skips a variant whose PLN amount cannot produce a real price (e.g. zero)", () => {
    const plan = planCurrencyRecompute([variant({ plnAmount: 0 })], RATE, MARGIN);
    expect(plan.skippedNoPlnPrice).toBe(1);
  });

  it("skips a manually-overridden price and does not queue a write for it", () => {
    const plan = planCurrencyRecompute(
      [variant({ existingDefaultPrice: { amount: 99, id: "price_manual" }, managedRecord: null })],
      RATE,
      MARGIN,
    );
    expect(plan.skippedManualOverride).toBe(1);
    expect(plan.writes).toHaveLength(0);
  });

  it("updates a plugin-managed price whose target has moved", () => {
    const plan = planCurrencyRecompute(
      [
        variant({
          existingDefaultPrice: { amount: 25, id: "price_managed" },
          managedRecord: { amount: 25, priceId: "price_managed" },
        }),
      ],
      RATE,
      MARGIN,
    );
    expect(plan.updated).toBe(1);
    expect(plan.writes).toEqual([
      {
        priceId: "price_managed",
        productId: "prod_1",
        sourcePlnAmount: 100,
        targetAmount: 27.5,
        variantId: "variant_1",
      },
    ]);
  });

  it("counts a plugin-managed price already at the target as unchanged, with no write", () => {
    const plan = planCurrencyRecompute(
      [
        variant({
          existingDefaultPrice: { amount: 27.5, id: "price_managed" },
          managedRecord: { amount: 27.5, priceId: "price_managed" },
        }),
      ],
      RATE,
      MARGIN,
    );
    expect(plan.unchanged).toBe(1);
    expect(plan.writes).toHaveLength(0);
  });

  it("tallies a mixed batch of variants correctly", () => {
    const plan = planCurrencyRecompute(
      [
        variant({ variantId: "v-create" }),
        variant({ plnAmount: undefined, variantId: "v-no-pln" }),
        variant({
          existingDefaultPrice: { amount: 99, id: "price_manual" },
          variantId: "v-manual",
        }),
        variant({
          existingDefaultPrice: { amount: 25, id: "price_managed" },
          managedRecord: { amount: 25, priceId: "price_managed" },
          variantId: "v-update",
        }),
        variant({
          existingDefaultPrice: { amount: 27.5, id: "price_managed_2" },
          managedRecord: { amount: 27.5, priceId: "price_managed_2" },
          variantId: "v-unchanged",
        }),
      ],
      RATE,
      MARGIN,
    );
    expect(plan.created).toBe(1);
    expect(plan.updated).toBe(1);
    expect(plan.unchanged).toBe(1);
    expect(plan.skippedManualOverride).toBe(1);
    expect(plan.skippedNoPlnPrice).toBe(1);
    expect(plan.writes.map((write) => write.variantId).sort()).toEqual(["v-create", "v-update"]);
  });

  it("returns an all-zero plan for an empty variant list", () => {
    const plan = planCurrencyRecompute([], RATE, MARGIN);
    expect(plan).toEqual({
      created: 0,
      skippedManualOverride: 0,
      skippedNoPlnPrice: 0,
      skippedQuantityTiered: 0,
      unchanged: 0,
      updated: 0,
      writes: [],
    });
  });

  it("skips a quantity-tiered variant under its own counter, not as a missing PLN price", () => {
    const plan = planCurrencyRecompute(
      [variant({ plnAmount: undefined, quantityTiered: true })],
      RATE,
      MARGIN,
    );
    expect(plan.skippedQuantityTiered).toBe(1);
    expect(plan.skippedNoPlnPrice).toBe(0);
    expect(plan.writes).toHaveLength(0);
  });

  // AI-655: planCurrencyRecompute passes vatAdjustment straight through to
  // computeForeignAmount - see that function's own tests for the VAT math
  // itself. These just pin the pass-through and the backward-compatible
  // no-op when it is omitted.
  describe("VAT adjustment pass-through (AI-655)", () => {
    it("is unaffected when no vatAdjustment is passed - the pre-AI-655 behavior", () => {
      const plan = planCurrencyRecompute([variant({ plnAmount: 123 })], RATE, MARGIN);
      expect(plan.writes).toEqual([
        { productId: "prod_1", sourcePlnAmount: 123, targetAmount: 33.83, variantId: "variant_1" },
      ]);
    });

    it("strips VAT from the PLN amount before computing the target when passed through", () => {
      const plan = planCurrencyRecompute([variant({ plnAmount: 123 })], RATE, MARGIN, {
        sourceIncludesVat: true,
        vatRate: 0.23,
      });
      // 123 gross / 1.23 = 100 net; 100 / 4 * 1.1 = 27.5.
      expect(plan.writes).toEqual([
        { productId: "prod_1", sourcePlnAmount: 123, targetAmount: 27.5, variantId: "variant_1" },
      ]);
    });

    it("records sourcePlnAmount as the raw (gross) PLN amount even when VAT was stripped for the target", () => {
      const plan = planCurrencyRecompute([variant({ plnAmount: 123 })], RATE, MARGIN, {
        sourceIncludesVat: true,
        vatRate: 0.23,
      });
      // The audit trail keeps the actual source price, not the intermediate
      // net base used only for the conversion.
      expect(plan.writes[0]?.sourcePlnAmount).toBe(123);
    });
  });
});
