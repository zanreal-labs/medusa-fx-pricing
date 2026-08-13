import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { FX_PRICING_MODULE, fetchNbpRate } from "../../../../modules/fx-pricing";
import type { FxPricingSettingsPatch, NbpRate } from "../../../../modules/fx-pricing";
import type FxPricingModuleService from "../../../../modules/fx-pricing/service";
import { updateFxPricingSettingsWorkflow } from "../../../../workflows/update-fx-pricing-settings";

/** A sane ceiling against a fat-fingered margin (10x), not a real business limit. */
const MAX_MARGIN_MULTIPLIER = 10;
const MAX_STALENESS_TOLERANCE_HOURS = 24 * 30;

const WRITABLE_KEYS = new Set(["enabled", "margin_multiplier", "staleness_tolerance_hours"]);

interface LiveRateDTO {
  mid: number;
  effectiveDate: string;
  tableNo: string;
  error?: undefined;
}

interface LiveRateErrorDTO {
  error: string;
}

/**
 * Fetch USD and EUR live, in parallel, for the Settings page's "current NBP
 * rates" display. Best-effort: a failure fetching one (or both) currencies
 * never fails the whole request - the config and last-run-summary half of
 * the response is still useful on its own, and the page shows the fetch
 * error inline for whichever currency it happened to.
 */
async function fetchLiveRates(): Promise<Record<"usd" | "eur", LiveRateDTO | LiveRateErrorDTO>> {
  const [usd, eur] = await Promise.allSettled([fetchNbpRate("usd"), fetchNbpRate("eur")]);
  const toDTO = (result: PromiseSettledResult<NbpRate>): LiveRateDTO | LiveRateErrorDTO =>
    result.status === "fulfilled"
      ? { effectiveDate: result.value.effectiveDate, mid: result.value.mid, tableNo: result.value.tableNo }
      : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
  return { eur: toDTO(eur), usd: toDTO(usd) };
}

/**
 * GET /admin/fx-pricing/config
 *
 * Everything Settings > FX pricing needs to render: the resolved runtime
 * configuration (the toggle's persisted/forced/effective state, the
 * resolved margin and staleness tolerance), the live NBP rates for USD/EUR
 * fetched fresh on every call, and the most recent run's summary.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const service: FxPricingModuleService = req.scope.resolve(FX_PRICING_MODULE);
  const [settings, runtimeOptions, liveRates] = await Promise.all([
    service.getSettings(),
    service.getResolvedRuntimeOptions(),
    fetchLiveRates(),
  ]);

  res.json({
    effectiveEnabled: runtimeOptions.effectiveEnabled,
    forceDisabled: runtimeOptions.forceDisabled,
    lastRunAt: settings.last_run_at,
    lastRunSummary: settings.last_run_summary,
    liveRates,
    marginMultiplier: runtimeOptions.marginMultiplier,
    marginMultiplierOverridden: settings.margin_multiplier !== null,
    persistedEnabled: settings.enabled,
    stalenessToleranceHours: runtimeOptions.stalenessToleranceHours,
    stalenessToleranceHoursOverridden: settings.staleness_tolerance_hours !== null,
  });
}

interface ConfigPatchBody {
  enabled?: unknown;
  margin_multiplier?: unknown;
  staleness_tolerance_hours?: unknown;
}

/**
 * POST /admin/fx-pricing/config
 *
 * Persists an override for one or more settings:
 * `{ enabled?, margin_multiplier?, staleness_tolerance_hours? }`. Only the
 * keys present in the body are written. `margin_multiplier` and
 * `staleness_tolerance_hours` accept `null` to explicitly clear that
 * override back to the `medusa-config.ts` default - `enabled` does not
 * accept `null` (it is a real persisted toggle, not an override of a
 * fallback - see the model comment on `FxPricingSettings.enabled`).
 *
 * Once saved, the change is live on the very next run - scheduled or
 * manual - because `runFxPricingRecompute` resolves every one of these
 * through `getResolvedRuntimeOptions()` at the top of each run, never from a
 * value captured at boot.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = (req.body ?? {}) as ConfigPatchBody & Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!WRITABLE_KEYS.has(key)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Unknown setting \`${key}\`. Writable settings: ${[...WRITABLE_KEYS].join(", ")}.`,
      );
    }
  }
  if (Object.keys(body).length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Provide at least one setting to update: ${[...WRITABLE_KEYS].join(", ")}.`,
    );
  }

  const patch: FxPricingSettingsPatch = {};

  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ message: "enabled must be a boolean" });
      return;
    }
    patch.enabled = body.enabled;
  }

  if ("margin_multiplier" in body) {
    if (body.margin_multiplier === null) {
      patch.margin_multiplier = null;
    } else if (
      typeof body.margin_multiplier !== "number" ||
      !Number.isFinite(body.margin_multiplier) ||
      body.margin_multiplier <= 0 ||
      body.margin_multiplier > MAX_MARGIN_MULTIPLIER
    ) {
      res.status(400).json({
        message: `margin_multiplier must be a positive number up to ${MAX_MARGIN_MULTIPLIER} (e.g. 1.10 for a 10% margin), or null to clear the override`,
      });
      return;
    } else {
      patch.margin_multiplier = body.margin_multiplier;
    }
  }

  if ("staleness_tolerance_hours" in body) {
    if (body.staleness_tolerance_hours === null) {
      patch.staleness_tolerance_hours = null;
    } else if (
      typeof body.staleness_tolerance_hours !== "number" ||
      !Number.isInteger(body.staleness_tolerance_hours) ||
      body.staleness_tolerance_hours <= 0 ||
      body.staleness_tolerance_hours > MAX_STALENESS_TOLERANCE_HOURS
    ) {
      res.status(400).json({
        message: `staleness_tolerance_hours must be a positive integer up to ${MAX_STALENESS_TOLERANCE_HOURS}, or null to clear the override`,
      });
      return;
    } else {
      patch.staleness_tolerance_hours = body.staleness_tolerance_hours;
    }
  }

  await updateFxPricingSettingsWorkflow(req.scope).run({ input: patch });

  const service: FxPricingModuleService = req.scope.resolve(FX_PRICING_MODULE);
  const [settings, runtimeOptions, liveRates] = await Promise.all([
    service.getSettings(),
    service.getResolvedRuntimeOptions(),
    fetchLiveRates(),
  ]);
  res.json({
    effectiveEnabled: runtimeOptions.effectiveEnabled,
    forceDisabled: runtimeOptions.forceDisabled,
    lastRunAt: settings.last_run_at,
    lastRunSummary: settings.last_run_summary,
    liveRates,
    marginMultiplier: runtimeOptions.marginMultiplier,
    marginMultiplierOverridden: settings.margin_multiplier !== null,
    persistedEnabled: settings.enabled,
    stalenessToleranceHours: runtimeOptions.stalenessToleranceHours,
    stalenessToleranceHoursOverridden: settings.staleness_tolerance_hours !== null,
  });
}
