import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE_PRICE_INCLUDES_VAT,
  DEFAULT_STALENESS_TOLERANCE_HOURS,
  DEFAULT_VAT_RATE,
  resolveModuleOptions,
} from "../types";

describe("resolveModuleOptions", () => {
  it("resolves no margin at all when none was configured", () => {
    // The regression this guards: a shipped margin default is one store's
    // commercial preference published to every installer, and it would be
    // applied to real prices without anyone choosing it. `null` here is what
    // makes `runFxPricingRecompute` refuse instead of guessing.
    expect(resolveModuleOptions().marginMultiplier).toBeNull();
    expect(resolveModuleOptions({}).marginMultiplier).toBeNull();
  });

  it("keeps an explicitly configured margin, including an inert 1", () => {
    expect(resolveModuleOptions({ marginMultiplier: 1 }).marginMultiplier).toBe(1);
    expect(resolveModuleOptions({ marginMultiplier: 1.25 }).marginMultiplier).toBe(1.25);
  });

  it("ships inert: enabled is off unless it was turned on", () => {
    expect(resolveModuleOptions().enabled).toBe(false);
    expect(resolveModuleOptions({ enabled: true }).enabled).toBe(true);
  });

  it("still defaults the staleness tolerance, which is a schedule tolerance and not a preference", () => {
    expect(resolveModuleOptions().stalenessToleranceHours).toBe(
      DEFAULT_STALENESS_TOLERANCE_HOURS,
    );
    expect(resolveModuleOptions({ stalenessToleranceHours: 48 }).stalenessToleranceHours).toBe(48);
  });

  // AI-655: defaults match what production's `pln` `price_preference` actually
  // is (`is_tax_inclusive: true`, 23% VAT) - unlike the margin, this is a fact
  // about how the store's PLN price is configured, not a commercial choice, so
  // a real default is appropriate here.
  describe("VAT adjustment (AI-655)", () => {
    it("defaults sourcePriceIncludesVat to true, matching production's brutto PLN price", () => {
      expect(resolveModuleOptions().sourcePriceIncludesVat).toBe(DEFAULT_SOURCE_PRICE_INCLUDES_VAT);
      expect(resolveModuleOptions().sourcePriceIncludesVat).toBe(true);
    });

    it("defaults vatRate to 0.23 (the Polish standard rate)", () => {
      expect(resolveModuleOptions().vatRate).toBe(DEFAULT_VAT_RATE);
      expect(resolveModuleOptions().vatRate).toBe(0.23);
    });

    it("keeps an explicitly configured sourcePriceIncludesVat, including flipping it to false", () => {
      expect(resolveModuleOptions({ sourcePriceIncludesVat: false }).sourcePriceIncludesVat).toBe(false);
      expect(resolveModuleOptions({ sourcePriceIncludesVat: true }).sourcePriceIncludesVat).toBe(true);
    });

    it("keeps an explicitly configured vatRate", () => {
      expect(resolveModuleOptions({ vatRate: 0.08 }).vatRate).toBe(0.08);
    });
  });
});
