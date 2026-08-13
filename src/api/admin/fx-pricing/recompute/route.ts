import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { runFxPricingRecompute } from "../../../../workflows/recompute-fx-prices";

/**
 * POST /admin/fx-pricing/recompute
 *
 * Runs the same recompute the scheduled job runs, on demand - for testing a
 * configuration change, or forcing a run without waiting for the schedule.
 * Gated by the toggle the same way the job is: `runFxPricingRecompute`
 * checks `effectiveEnabled` itself and returns `{ ran: false }` without
 * writing anything when the plugin is off, rather than this route
 * duplicating that check and risking the two disagreeing.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const summary = await runFxPricingRecompute(req.scope);
  res.json({ summary });
}
