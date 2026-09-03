import { describe, expect, it } from "vitest";
import { formatFxPricingPreview } from "../preview-fx-prices";
import type { FxPricingPreviewResult } from "../preview-fx-prices";

function baseResult(overrides: Partial<FxPricingPreviewResult> = {}): FxPricingPreviewResult {
  return {
    currencies: [],
    generatedAt: "2026-09-03T00:00:00.000Z",
    marginMultiplier: 1.1,
    scopedVariantCount: null,
    vatAdjustment: { sourceIncludesVat: true, vatRate: 0.23 },
    ...overrides,
  };
}

describe("formatFxPricingPreview", () => {
  it("says a real run would refuse when no margin is configured, and previews nothing", () => {
    const report = formatFxPricingPreview(baseResult({ marginMultiplier: null, currencies: [] }));
    expect(report).toContain("NOT CONFIGURED");
    expect(report).toContain("a real run would refuse");
  });

  it("reports a currency disabled in the store's supported currencies", () => {
    const report = formatFxPricingPreview(
      baseResult({
        currencies: [
          {
            currency: "usd",
            currencyDisabled: true,
            rateStale: false,
            rateUnavailable: false,
            rows: [],
            skippedManualOverride: 0,
            skippedNoPlnPrice: 0,
            skippedQuantityTiered: 0,
            unchanged: 0,
          },
        ],
      }),
    );
    expect(report).toContain("USD");
    expect(report).toContain("not enabled in the store's supported currencies");
  });

  it("reports an unavailable NBP rate", () => {
    const report = formatFxPricingPreview(
      baseResult({
        currencies: [
          {
            currency: "eur",
            currencyDisabled: false,
            rateStale: false,
            rateUnavailable: true,
            rows: [],
            skippedManualOverride: 0,
            skippedNoPlnPrice: 0,
            skippedQuantityTiered: 0,
            unchanged: 0,
          },
        ],
      }),
    );
    expect(report).toContain("EUR");
    expect(report).toContain("NBP rate could not be fetched");
  });

  it("flags a stale rate", () => {
    const report = formatFxPricingPreview(
      baseResult({
        currencies: [
          {
            currency: "usd",
            currencyDisabled: false,
            rate: 4,
            rateEffectiveDate: "2026-08-01",
            rateStale: true,
            rateUnavailable: false,
            rows: [],
            skippedManualOverride: 0,
            skippedNoPlnPrice: 0,
            skippedQuantityTiered: 0,
            unchanged: 0,
          },
        ],
      }),
    );
    expect(report).toContain("STALE");
  });

  it("renders a create row with the net base called out when VAT was stripped", () => {
    const report = formatFxPricingPreview(
      baseResult({
        currencies: [
          {
            currency: "usd",
            currencyDisabled: false,
            rate: 4,
            rateEffectiveDate: "2026-09-01",
            rateStale: false,
            rateUnavailable: false,
            rows: [
              {
                action: "create",
                currentAmount: null,
                netPlnBase: 100,
                plnAmount: 123,
                productId: "prod_1",
                proposedAmount: 27.5,
                variantId: "variant_1",
              },
            ],
            skippedManualOverride: 0,
            skippedNoPlnPrice: 0,
            skippedQuantityTiered: 0,
            unchanged: 0,
          },
        ],
      }),
    );
    expect(report).toContain("create");
    expect(report).toContain("PLN 123.00");
    expect(report).toContain("net base 100.00");
    expect(report).toContain("USD 27.50");
    expect(report).toContain("current: none");
  });

  it("does not show a net base note when the source PLN amount was not adjusted", () => {
    const report = formatFxPricingPreview(
      baseResult({
        vatAdjustment: { sourceIncludesVat: false, vatRate: 0.23 },
        currencies: [
          {
            currency: "eur",
            currencyDisabled: false,
            rate: 4,
            rateEffectiveDate: "2026-09-01",
            rateStale: false,
            rateUnavailable: false,
            rows: [
              {
                action: "update",
                currentAmount: 20,
                netPlnBase: 100,
                plnAmount: 100,
                productId: "prod_1",
                proposedAmount: 27.5,
                variantId: "variant_1",
              },
            ],
            skippedManualOverride: 0,
            skippedNoPlnPrice: 0,
            skippedQuantityTiered: 0,
            unchanged: 0,
          },
        ],
      }),
    );
    expect(report).not.toContain("net base");
    expect(report).toContain("current: 20.00");
  });

  it("includes the skip/unchanged counters for a currency even with no rows", () => {
    const report = formatFxPricingPreview(
      baseResult({
        currencies: [
          {
            currency: "usd",
            currencyDisabled: false,
            rate: 4,
            rateEffectiveDate: "2026-09-01",
            rateStale: false,
            rateUnavailable: false,
            rows: [],
            skippedManualOverride: 2,
            skippedNoPlnPrice: 3,
            skippedQuantityTiered: 9,
            unchanged: 61,
          },
        ],
      }),
    );
    expect(report).toContain("would create/update: 0");
    expect(report).toContain("unchanged: 61");
    expect(report).toContain("manualOverride: 2");
    expect(report).toContain("noPlnPrice: 3");
    expect(report).toContain("quantityTiered: 9");
  });
});
