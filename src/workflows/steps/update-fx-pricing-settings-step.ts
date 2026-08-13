import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { FX_PRICING_MODULE } from "../../modules/fx-pricing";
import type FxPricingModuleService from "../../modules/fx-pricing/service";
import type { FxPricingSettingsPatch } from "../../modules/fx-pricing/types";

/**
 * Thin step wrapper around the module service's `updateSettings`. No
 * compensation function: this workflow has exactly one step, so there is no
 * later step whose failure would need this write reverted.
 */
export const updateFxPricingSettingsStep = createStep(
  "update-fx-pricing-settings",
  async (input: FxPricingSettingsPatch, { container }) => {
    const service: FxPricingModuleService = container.resolve(FX_PRICING_MODULE);
    const settings = await service.updateSettings(input);
    return new StepResponse(settings);
  },
);
