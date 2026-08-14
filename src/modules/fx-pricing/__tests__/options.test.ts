import { describe, expect, it } from "vitest";
import { DEFAULT_STALENESS_TOLERANCE_HOURS, resolveModuleOptions } from "../types";

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
});
