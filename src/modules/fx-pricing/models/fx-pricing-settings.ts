import { model } from "@medusajs/framework/utils";

/**
 * The persisted, operator-editable configuration for the fx-pricing plugin.
 *
 * A SINGLETON: exactly one row exists, keyed by the fixed id
 * `FX_PRICING_SETTINGS_ID` (in the service).
 *
 * `enabled` is NOT nullable, unlike the two fields below it. This is
 * deliberately the allegro-plugin "runtime toggle" pattern, not the
 * product-costs "nullable override" pattern: there is no meaningful
 * "fall back to moduleOptions on every read" for a kill switch - an
 * operator flips it and that is the answer until they flip it again. It is
 * seeded from `moduleOptions.enabled` (itself defaulting to `false`) only
 * once, the moment this row is first created, matching the hard requirement
 * that a fresh install never writes a price until an operator explicitly
 * turns this on. `FX_PRICING_DISABLED` in the environment can still force
 * the EFFECTIVE state to off regardless of what is persisted here - see
 * `resolveEffectiveEnabled` in `src/modules/fx-pricing/lib/../../../lib`
 * (re-exported from the service) - but it can only ever force off, never on.
 *
 * `margin_multiplier` and `staleness_tolerance_hours` follow the
 * product-costs precedent instead: nullable, with `null` meaning "not
 * overridden here", falling back to the `medusa-config.ts` plugin option
 * (`moduleOptions.marginMultiplier` / `moduleOptions.stalenessToleranceHours`)
 * on every read. That fallback is resolved in the service's
 * `getResolvedRuntimeOptions()`, the one place every part of this plugin
 * (the job, the manual action, the admin config route) reads margin and
 * staleness tolerance from - so a value saved from Settings > FX pricing
 * takes effect on the very next run, no backend restart.
 *
 * `last_run_at` / `last_run_summary` are not "configuration" in the same
 * sense - they are the last recompute's own report, written by the job/manual
 * action after each run and read back by the Settings page. They live on
 * this same singleton row because there is exactly one of each, the same
 * shape as everything else here.
 */
const FxPricingSettings = model.define("fx_pricing_settings", {
  /** The persisted kill switch. Defaults to `false` at the column level too, as a second line of defense if a row is ever inserted without going through the service's seeded create. */
  enabled: model.boolean().default(false),
  id: model.id({ prefix: "fxpset" }).primaryKey(),
  /** Timestamp of the most recently finished recompute run (scheduled or manual), regardless of outcome. `null` before the first run ever completes. */
  last_run_at: model.dateTime().nullable(),
  /** The `RunSummary` (see `types.ts`) of the most recently finished run, as JSON. `null` before the first run. */
  last_run_summary: model.json().nullable(),
  /** Margin multiplier override, e.g. `1.10` for 10%. `null` = use `moduleOptions.marginMultiplier`. */
  margin_multiplier: model.bigNumber().nullable(),
  /** Staleness tolerance override, in hours. `null` = use `moduleOptions.stalenessToleranceHours`. */
  staleness_tolerance_hours: model.number().nullable(),
});

export default FxPricingSettings;
