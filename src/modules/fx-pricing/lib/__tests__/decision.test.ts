import { describe, expect, it } from "vitest";
import { decidePriceAction } from "../decision";

describe("decidePriceAction", () => {
  it("creates when the variant has no price at all in the target currency", () => {
    const result = decidePriceAction({
      existingDefaultPrice: null,
      managedRecord: null,
      targetAmount: 27.5,
    });
    expect(result).toEqual({ action: "create" });
  });

  it("creates even when a stale managed record exists but the live price was deleted (the reclaim path)", () => {
    const result = decidePriceAction({
      existingDefaultPrice: null,
      managedRecord: { amount: 27.5, priceId: "price_old" },
      targetAmount: 30,
    });
    expect(result).toEqual({ action: "create" });
  });

  it("skips as a manual override when a price exists but this plugin never recorded writing one", () => {
    const result = decidePriceAction({
      existingDefaultPrice: { amount: 99, id: "price_123" },
      managedRecord: null,
      targetAmount: 27.5,
    });
    expect(result).toEqual({ action: "skip", reason: "manual-override" });
  });

  it("skips as a manual override when the live price id differs from what this plugin recorded", () => {
    const result = decidePriceAction({
      existingDefaultPrice: { amount: 27.5, id: "price_new" },
      managedRecord: { amount: 27.5, priceId: "price_old" },
      targetAmount: 27.5,
    });
    expect(result).toEqual({ action: "skip", reason: "manual-override" });
  });

  it("skips as a manual override when the price id matches but the amount was edited directly", () => {
    const result = decidePriceAction({
      existingDefaultPrice: { amount: 40, id: "price_123" },
      managedRecord: { amount: 27.5, priceId: "price_123" },
      targetAmount: 30,
    });
    expect(result).toEqual({ action: "skip", reason: "manual-override" });
  });

  it("updates when the price is still exactly what this plugin left it as, and the target has moved", () => {
    const result = decidePriceAction({
      existingDefaultPrice: { amount: 27.5, id: "price_123" },
      managedRecord: { amount: 27.5, priceId: "price_123" },
      targetAmount: 30,
    });
    expect(result).toEqual({ action: "update", priceId: "price_123" });
  });

  it("is a noop when the price is still ours and already at the target amount", () => {
    const result = decidePriceAction({
      existingDefaultPrice: { amount: 27.5, id: "price_123" },
      managedRecord: { amount: 27.5, priceId: "price_123" },
      targetAmount: 27.5,
    });
    expect(result).toEqual({ action: "noop", priceId: "price_123" });
  });

  it("never treats a coincidental amount match with no managed record as ownership", () => {
    // The live price happens to equal what this run would compute, but this
    // plugin never wrote it - still sacred.
    const result = decidePriceAction({
      existingDefaultPrice: { amount: 27.5, id: "price_123" },
      managedRecord: null,
      targetAmount: 27.5,
    });
    expect(result).toEqual({ action: "skip", reason: "manual-override" });
  });
});
