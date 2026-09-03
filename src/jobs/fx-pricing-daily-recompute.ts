import type { MedusaContainer } from "@medusajs/framework/types";
import { runFxPricingRecompute } from "../workflows/recompute-fx-prices";

const JOB_NAME = "fx-pricing-daily-recompute";

/**
 * The daily USD/EUR recompute - the BACKSTOP, not the primary path.
 *
 * The primary path is the subscriber in `src/subscribers`, which reprices the
 * affected variants within seconds of a PLN price changing. This job exists for
 * everything that path cannot see, and there is a real list of it:
 *
 * - **The rate moved, not the price.** NBP publishes a new table A every
 *   business day and no store event accompanies it. Nothing but a schedule can
 *   notice that yesterday's USD price is now off by a day of currency drift -
 *   which is, after all, the entire point of this plugin.
 * - **A price written outside a workflow.** `pricing.updatePriceSets` called
 *   from a script, a migration, or raw SQL changes what customers are quoted
 *   and emits either no event or one this plugin deliberately ignores.
 * - **An event that was dropped.** A backend restart mid-burst, a Redis event
 *   bus that lost a message, a subscriber that threw. Every event-driven system
 *   needs a pass that assumes it missed something.
 * - **A price handed back.** Deleting a manually-overridden USD price makes the
 *   variant eligible again (see `decidePriceAction`), but the deletion itself is
 *   not a trigger this plugin acts on - the row is already gone, so there is
 *   nothing left to read a currency off.
 *
 * `runFxPricingRecompute` (see `src/workflows/recompute-fx-prices.ts`) owns the
 * toggle check - when Settings > FX pricing is off (or `FX_PRICING_DISABLED`
 * forces it off), it logs "skipped (disabled...)" itself and returns immediately
 * with `{ ran: false }`, which is exactly the "no-op and log" behavior required
 * of this job. There is nothing left for this job to gate - it exists to give
 * that shared function a schedule.
 *
 * This is the only caller that leaves `variantIds` unset, so it is the only one
 * that scans the whole catalog and the only one whose summary is persisted as
 * `last_run_summary`.
 */
export default async function fxPricingDailyRecomputeJob(container: MedusaContainer): Promise<void> {
  await runFxPricingRecompute(container, { trigger: "scheduled" });
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
