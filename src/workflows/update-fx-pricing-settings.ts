import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { updateFxPricingSettingsStep } from "./steps/update-fx-pricing-settings-step";
import type { FxPricingSettingsPatch } from "../modules/fx-pricing/types";

/**
 * Persists an operator-saved settings change from Settings > FX pricing. A
 * one-step workflow - the write itself is the whole operation - kept as a
 * workflow rather than a direct service call from the API route, matching
 * `medusa-product-costs`'s `updateProductCostsSettingsWorkflow` convention.
 */
export const updateFxPricingSettingsWorkflow = createWorkflow(
  "update-fx-pricing-settings",
  (input: FxPricingSettingsPatch) => {
    const settings = updateFxPricingSettingsStep(input);
    return new WorkflowResponse(settings);
  },
);
