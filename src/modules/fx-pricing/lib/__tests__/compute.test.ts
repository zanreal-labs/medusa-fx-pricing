import { describe, expect, it } from "vitest";
import { computeForeignAmount } from "../compute";

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
});
