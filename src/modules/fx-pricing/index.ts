import { Module } from "@medusajs/framework/utils";
import FxPricingModuleService from "./service";

export const FX_PRICING_MODULE = "fxPricing";

export default Module(FX_PRICING_MODULE, {
  service: FxPricingModuleService,
});

export { default as FxPricingModuleService } from "./service";
export * from "./types";
export * from "./lib/compute";
export * from "./lib/decision";
export * from "./lib/errors";
export * from "./lib/money";
export * from "./lib/nbp";
