import type { MedusaContainer } from "@medusajs/framework/types";
import { runFxPricingRecompute } from "../workflows/recompute-fx-prices";

const JOB_NAME = "fx-pricing-daily-recompute";

/**
 * The daily USD/EUR recompute. `runFxPricingRecompute` (see
 * `src/workflows/recompute-fx-prices.ts`) owns the toggle check - when
 * Settings > FX pricing is off (or `FX_PRICING_DISABLED` forces it off),
 * it logs "skipped (disabled...)" itself and returns immediately with
 * `{ ran: false }`, which is exactly the "no-op and log" behavior required
 * of this job. There is nothing left for this job to gate - it exists to
 * give that shared function a schedule.
 */
export default async function fxPricingDailyRecomputeJob(container: MedusaContainer): Promise<void> {
  await runFxPricingRecompute(container);
}

export const config = {
  name: JOB_NAME,
  /**
   * Once a day, at 03:00 - after the NBP table A publication window (NBP
   * publishes on business days at 11:15 CET) has long closed for the
   * PREVIOUS day and well before most stores' business hours, so a price
   * change from this job is never visible mid-shopping-session. Overridable
   * via `FX_PRICING_CRON` for a store on a different timezone/traffic
   * pattern - Medusa evaluates a scheduled job's `config.schedule` at
   * plugin-load time, before the DI container (and this plugin's resolved
   * options) exists, so the schedule itself has to be read from the
   * environment rather than from a plugin option or the persisted settings
   * - the same constraint the sibling `medusa-allegro` plugin documents on
   * its own job.
   */
  schedule: process.env.FX_PRICING_CRON ?? "0 3 * * *",
};
