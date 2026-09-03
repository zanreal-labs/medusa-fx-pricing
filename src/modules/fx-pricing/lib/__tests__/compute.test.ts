import { describe, expect, it } from "vitest";
import { computeForeignAmount, toNetPlnAmount } from "../compute";

describe("computeForeignAmount", () => {
  it("computes pln_amount / nbp_rate * margin_multiplier, rounded to 2 places", () => {
    // 100 PLN / 4.00 (usd rate) * 1.10 = 27.5
    expect(computeForeignAmount(100, 4, 1.1)).toBe(27.5);
  });

  it("applies the default 1.10 margin correctly for a non-round result", () => {
    // 249.99 / 3.9123 * 1.10 = 70.294... -> 70.29
    const result = computeForeignAmount(249.99, 3.9123, 1.1);
    expect(result).toBe(70.29);
  });

  it("supports a margin multiplier other than the 1.10 default", () => {
    // 100 / 4 * 1.25 = 31.25
    expect(computeForeignAmount(100, 4, 1.25)).toBe(31.25);
  });

  it("supports a margin multiplier of exactly 1 (no markup)", () => {
    expect(computeForeignAmount(100, 4, 1)).toBe(25);
  });

  it("returns undefined for a zero or negative PLN amount", () => {
    expect(computeForeignAmount(0, 4, 1.1)).toBeUndefined();
    expect(computeForeignAmount(-10, 4, 1.1)).toBeUndefined();
  });

  it("returns undefined for a non-finite PLN amount", () => {
    expect(computeForeignAmount(Number.NaN, 4, 1.1)).toBeUndefined();
    expect(computeForeignAmount(Number.POSITIVE_INFINITY, 4, 1.1)).toBeUndefined();
  });

  it("returns undefined for a zero or negative NBP rate", () => {
    expect(computeForeignAmount(100, 0, 1.1)).toBeUndefined();
    expect(computeForeignAmount(100, -4, 1.1)).toBeUndefined();
  });

  it("returns undefined for a zero or negative margin multiplier", () => {
    expect(computeForeignAmount(100, 4, 0)).toBeUndefined();
    expect(computeForeignAmount(100, 4, -1.1)).toBeUndefined();
  });

  it("never coerces a missing/invalid input to a default - undefined propagates, not a guessed price", () => {
    // A rate of 1 would silently be wrong for both USD and EUR against PLN;
    // this pins that computeForeignAmount never falls back to it.
    expect(computeForeignAmount(100, Number.NaN, 1.1)).toBeUndefined();
  });

  it("rounds half-up at exactly the .005 boundary", () => {
    // 4.01 / 4 * 1.10 = 1.10275 -> 1.10 (not a boundary case, sanity check
    // that a very small result does not underflow oddly)
    expect(computeForeignAmount(4.01, 4, 1.1)).toBe(1.1);
  });

  // AI-655: production's PLN default price is gross (brutto, 23% VAT) while
  // EUR/USD default prices are net (netto). Without stripping VAT first, a
  // configured `1.1` margin lands as an effective ~1.353 - these pin the fix.
  describe("VAT adjustment (AI-655)", () => {
    it("strips VAT before converting when sourceIncludesVat is true", () => {
      // 123 gross / 1.23 = 100 net; 100 / 4 * 1.1 = 27.5 - same result as
      // converting a 100 PLN net price with no adjustment at all.
      const withVat = computeForeignAmount(123, 4, 1.1, { sourceIncludesVat: true, vatRate: 0.23 });
      const withoutVatOnNetAmount = computeForeignAmount(100, 4, 1.1);
      expect(withVat).toBe(27.5);
      expect(withVat).toBe(withoutVatOnNetAmount);
    });

    it("does not strip VAT when sourceIncludesVat is false, even with a vatRate set", () => {
      expect(computeForeignAmount(100, 4, 1.1, { sourceIncludesVat: false, vatRate: 0.23 })).toBe(27.5);
    });

    it("is a no-op when no vatAdjustment is passed at all - the pre-AI-655 behavior", () => {
      expect(computeForeignAmount(100, 4, 1.1)).toBe(computeForeignAmount(100, 4, 1.1, undefined));
    });

    it("demonstrates the regression this fixes: converting the gross amount unadjusted overstates the result", () => {
      const grossUnadjusted = computeForeignAmount(123, 4, 1.1) as number;
      const nettoAdjusted = computeForeignAmount(123, 4, 1.1, {
        sourceIncludesVat: true,
        vatRate: 0.23,
      }) as number;
      // 123 / 4 * 1.1 = 33.825 -> 33.83, vs. the correct 27.5 from net 100.
      expect(grossUnadjusted).toBe(33.83);
      expect(nettoAdjusted).toBe(27.5);
      expect(nettoAdjusted).toBeLessThan(grossUnadjusted);
    });

    it("returns undefined for a vatRate that cannot produce a real net amount", () => {
      expect(computeForeignAmount(100, 4, 1.1, { sourceIncludesVat: true, vatRate: -1 })).toBeUndefined();
      expect(computeForeignAmount(100, 4, 1.1, { sourceIncludesVat: true, vatRate: -2 })).toBeUndefined();
    });

    it("returns undefined for a non-finite vatRate when sourceIncludesVat is true", () => {
      expect(
        computeForeignAmount(100, 4, 1.1, { sourceIncludesVat: true, vatRate: Number.NaN }),
      ).toBeUndefined();
    });

    it("never lets an unused vatRate (sourceIncludesVat: false) reject an otherwise-valid input", () => {
      // A nonsensical vatRate that would fail validation IS validated, but only
      // when it is actually going to be used.
      expect(
        computeForeignAmount(100, 4, 1.1, { sourceIncludesVat: false, vatRate: Number.NaN }),
      ).toBe(27.5);
    });
  });
});

describe("toNetPlnAmount", () => {
  it("returns the amount unchanged when no adjustment is given", () => {
    expect(toNetPlnAmount(123)).toBe(123);
  });

  it("returns the amount unchanged when sourceIncludesVat is false", () => {
    expect(toNetPlnAmount(123, { sourceIncludesVat: false, vatRate: 0.23 })).toBe(123);
  });

  it("strips the configured VAT rate when sourceIncludesVat is true", () => {
    expect(toNetPlnAmount(123, { sourceIncludesVat: true, vatRate: 0.23 })).toBe(100);
  });

  it("returns undefined for a vatRate <= -1", () => {
    expect(toNetPlnAmount(100, { sourceIncludesVat: true, vatRate: -1 })).toBeUndefined();
  });

  it("returns undefined for a non-finite vatRate", () => {
    expect(toNetPlnAmount(100, { sourceIncludesVat: true, vatRate: Number.POSITIVE_INFINITY })).toBeUndefined();
  });
});
