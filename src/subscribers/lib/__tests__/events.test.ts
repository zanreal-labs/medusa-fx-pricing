import { describe, expect, it } from "vitest";
import { FX_PRICING_TRIGGER_EVENTS, parseFxPricingEvent } from "../events";

describe("FX_PRICING_TRIGGER_EVENTS", () => {
  it("covers every path a PLN price can change through, and nothing else", () => {
    expect([...FX_PRICING_TRIGGER_EVENTS]).toEqual([
      "product.created",
      "product.updated",
      "product-variant.created",
      "product-variant.updated",
      "pricing.price.created",
      "pricing.price.updated",
    ]);
  });

  it("does not subscribe to price deletions, whose currency can no longer be read", () => {
    // The recursion guard is the price's currency, and a deleted row has none -
    // see the comment on `FX_PRICING_TRIGGER_EVENTS`.
    expect(FX_PRICING_TRIGGER_EVENTS).not.toContain("pricing.price.deleted");
  });
});

describe("parseFxPricingEvent", () => {
  it("reads a single-id payload, the shape emitEventStep produces", () => {
    expect(parseFxPricingEvent("product-variant.updated", { id: "variant_1" })).toEqual({
      ids: ["variant_1"],
      subject: "variant",
    });
  });

  it("reads an array-of-ids payload, the shape moduleEventBuilderFactory produces for a multi-row write", () => {
    expect(parseFxPricingEvent("pricing.price.created", { id: ["price_1", "price_2"] })).toEqual({
      ids: ["price_1", "price_2"],
      subject: "price",
    });
  });

  it("reads an array-of-rows payload", () => {
    expect(
      parseFxPricingEvent("product.created", [{ id: "prod_1" }, { id: "prod_2" }]),
    ).toEqual({ ids: ["prod_1", "prod_2"], subject: "product" });
  });

  it("reads the documented `ids` payload", () => {
    expect(parseFxPricingEvent("product.updated", { ids: ["prod_1"] })).toEqual({
      ids: ["prod_1"],
      subject: "product",
    });
  });

  it("de-duplicates ids so one variant named twice is recomputed once", () => {
    expect(
      parseFxPricingEvent("product-variant.updated", [{ id: "variant_1" }, { id: "variant_1" }]),
    ).toEqual({ ids: ["variant_1"], subject: "variant" });
  });

  it("ignores an event it does not subscribe to", () => {
    expect(parseFxPricingEvent("pricing.price.deleted", { id: "price_1" })).toBeNull();
    expect(parseFxPricingEvent("product.deleted", { id: "prod_1" })).toBeNull();
    expect(parseFxPricingEvent("order.placed", { id: "order_1" })).toBeNull();
  });

  it("matches on the exact event name, never on a prefix", () => {
    // A prefix test would silently widen the subscription every time Medusa adds
    // an entity under `pricing.` - and the recursion guard depends on knowing
    // exactly which events can reach it.
    expect(parseFxPricingEvent("pricing.price_set.updated", { id: "pset_1" })).toBeNull();
    expect(parseFxPricingEvent("pricing.price_list.created", { id: "plist_1" })).toBeNull();
    expect(parseFxPricingEvent("product-variant.restored", { id: "variant_1" })).toBeNull();
  });

  it("returns null rather than guessing when no usable id is carried", () => {
    expect(parseFxPricingEvent("product.updated", {})).toBeNull();
    expect(parseFxPricingEvent("product.updated", { id: "" })).toBeNull();
    expect(parseFxPricingEvent("product.updated", { id: 42 })).toBeNull();
    expect(parseFxPricingEvent("product.updated", null)).toBeNull();
    expect(parseFxPricingEvent("product.updated", undefined)).toBeNull();
    expect(parseFxPricingEvent("product.updated", [])).toBeNull();
  });
});
