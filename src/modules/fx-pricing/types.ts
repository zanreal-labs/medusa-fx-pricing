import type { FxSourceCurrency } from "./lib/nbp";

/**
 * The `medusa-config.ts` plugin options. Every field here is a DEFAULT, not
 * the final word - `enabled` seeds the persisted settings singleton on its
 * first read (see `FxPricingSettings`/the service), and `marginMultiplier` /
 * `stalenessToleranceHours` are what a `null` (not overridden) column on
 * that singleton falls back to. An operator can change any of the three from
 * Settings > FX pricing without touching this file or restarting the
 * backend - see the README's "Persisted settings" section.
 */
export interface FxPricingModuleOptions {
  /**
   * Whether the daily job and the manual "recompute now" action are armed on
   * a fresh install, before an operator has ever opened Settings > FX
   * pricing. Defaults to `false` - this plugin ships inert until explicitly
   * turned on, per the hard requirement that a fresh install never writes a
   * price on its own.
   */
  enabled?: boolean;
  /** The margin multiplier applied on top of the raw NBP mid rate. Defaults to `1.10` (10%). */
  marginMultiplier?: number;
  /**
   * How many hours old the latest published NBP table A rate for a currency
   * may be before this plugin treats it as stale and skips that currency for
   * the run (logging why) rather than pricing off a rate that is unusually
   * old for reasons beyond an ordinary weekend/holiday gap. Defaults to
   * `120` (5 days) - enough to ride out a long holiday weekend without
   * flagging every Monday run as stale, while still catching a genuinely
   * broken publication.
   */
  stalenessToleranceHours?: number;
}

export interface ResolvedFxPricingModuleOptions {
  enabled: boolean;
  marginMultiplier: number;
  stalenessToleranceHours: number;
}

export const DEFAULT_MARGIN_MULTIPLIER = 1.1;
export const DEFAULT_STALENESS_TOLERANCE_HOURS = 120;

export function resolveModuleOptions(
  options?: FxPricingModuleOptions,
): ResolvedFxPricingModuleOptions {
  return {
    enabled: options?.enabled ?? false,
    marginMultiplier: options?.marginMultiplier ?? DEFAULT_MARGIN_MULTIPLIER,
    stalenessToleranceHours: options?.stalenessToleranceHours ?? DEFAULT_STALENESS_TOLERANCE_HOURS,
  };
}

/** The `fx_pricing_settings` singleton row, as returned from the service. */
export interface FxPricingSettingsRow {
  id: string;
  /** The persisted operator toggle. Always a real boolean - see the model comment for why it is not nullable like the two fields below. */
  enabled: boolean;
  /** `null` = not overridden, fall back to `moduleOptions.marginMultiplier`. */
  margin_multiplier: number | null;
  /** `null` = not overridden, fall back to `moduleOptions.stalenessToleranceHours`. */
  staleness_tolerance_hours: number | null;
  last_run_at: Date | null;
  last_run_summary: RunSummary | null;
}

/** A patch to `fx_pricing_settings`. Only the keys present are written - see the API route. */
export interface FxPricingSettingsPatch {
  enabled?: boolean;
  margin_multiplier?: number | null;
  staleness_tolerance_hours?: number | null;
}

/** What everything else in this plugin should actually run with, resolved per field. */
export interface ResolvedRuntimeOptions {
  /** `settings.enabled`, unaffected by the environment force-off - see `effectiveEnabled`. */
  persistedEnabled: boolean;
  /** `persistedEnabled && !forceDisabled` - what the job and the manual action actually check. */
  effectiveEnabled: boolean;
  /** Whether `FX_PRICING_DISABLED` is set, forcing `effectiveEnabled` to `false` regardless of the persisted toggle. */
  forceDisabled: boolean;
  marginMultiplier: number;
  stalenessToleranceHours: number;
}

/** Per-currency counters for one recompute run, surfaced in the admin and persisted on the settings row. */
export interface CurrencyRunSummary {
  /** Currency not enabled in the store's `supported_currencies` - nothing was attempted. */
  currencyDisabled: boolean;
  /** The NBP rate could not be fetched/parsed this run - nothing was attempted. */
  rateUnavailable: boolean;
  /** The fetched rate is older than the staleness tolerance - nothing was attempted. */
  rateStale: boolean;
  created: number;
  updated: number;
  /** Already at the target amount and still plugin-managed - nothing to write. */
  unchanged: number;
  /** Skipped because the live price is a manual override - see `decidePriceAction`. */
  skippedManualOverride: number;
  /** Variant had no default PLN price to convert from. */
  skippedNoPlnPrice: number;
  rate?: number;
  rateEffectiveDate?: string;
}

/**
 * The full summary of one recompute run, persisted as
 * `fx_pricing_settings.last_run_summary` (a `model.json()` column, typed as
 * `Record<string, unknown>` by the generated service methods). The index
 * signature makes this interface structurally assignable to that column's
 * type without a cast at every call site - every named property below is
 * still fully typed for everyone reading a `RunSummary` value back.
 */
export interface RunSummary {
  [key: string]: unknown;
  ranAt: string;
  /** `false` when the run did nothing because the toggle was off - see the job. */
  ran: boolean;
  currencies: Partial<Record<FxSourceCurrency, CurrencyRunSummary>>;
  error?: string;
}

/** The `fx_managed_price` row, as returned from the service. */
export interface FxManagedPriceRow {
  id: string;
  variant_id: string;
  currency_code: FxSourceCurrency;
  price_id: string;
  amount: number;
  source_pln_amount: number;
  nbp_rate: number;
  margin_multiplier: number;
  computed_at: Date;
}
