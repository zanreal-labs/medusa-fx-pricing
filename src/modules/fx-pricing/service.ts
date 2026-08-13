import { MedusaError, MedusaService } from "@medusajs/framework/utils";
import FxManagedPrice from "./models/fx-managed-price";
import FxPricingSettings from "./models/fx-pricing-settings";
import type { FxSourceCurrency } from "./lib/nbp";
import type {
  FxManagedPriceRow,
  FxPricingSettingsPatch,
  FxPricingSettingsRow,
  ResolvedFxPricingModuleOptions,
  ResolvedRuntimeOptions,
  RunSummary,
} from "./types";
import { resolveModuleOptions } from "./types";
import type { FxPricingModuleOptions } from "./types";

/**
 * Fixed primary key for the settings singleton - see `FxPricingSettings`
 * for why a fixed id makes this a true singleton.
 */
export const FX_PRICING_SETTINGS_ID = "fxpset_singleton";

/**
 * Forces `effectiveEnabled` to `false` regardless of the persisted toggle.
 * Can only ever force OFF, never on - see `resolveEffectiveEnabled` and the
 * model comment on `FxPricingSettings.enabled`.
 */
const FORCE_DISABLE_ENV_VAR = "FX_PRICING_DISABLED";

/**
 * The runtime-toggle precedence, mirroring `resolveEffectiveEnabled` in the
 * sibling `medusa-allegro` plugin: the persisted toggle governs, and the
 * environment override can only ever pull it to `false`, never push it to
 * `true`. Written with explicit `=== true` / `!== true` rather than
 * truthiness so a stray `undefined` reads as "not armed" / "not forced off"
 * - the conservative reading in both directions.
 */
function resolveEffectiveEnabled(persistedEnabled: boolean, forceDisabled: boolean): boolean {
  return persistedEnabled === true && forceDisabled !== true;
}

function isEnvForceDisabled(): boolean {
  const raw = process.env[FORCE_DISABLE_ENV_VAR];
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

type InjectedDependencies = Record<string, unknown>;

function toSettingsDTO(row: Record<string, unknown>): FxPricingSettingsRow {
  return {
    enabled: row.enabled === true,
    id: row.id as string,
    last_run_at: (row.last_run_at as Date | null) ?? null,
    last_run_summary: (row.last_run_summary as RunSummary | null) ?? null,
    margin_multiplier:
      row.margin_multiplier === null || row.margin_multiplier === undefined
        ? null
        : Number(row.margin_multiplier),
    staleness_tolerance_hours:
      row.staleness_tolerance_hours === null || row.staleness_tolerance_hours === undefined
        ? null
        : Number(row.staleness_tolerance_hours),
  };
}

function toManagedPriceDTO(row: Record<string, unknown>): FxManagedPriceRow {
  return {
    amount: Number(row.amount),
    computed_at: row.computed_at as Date,
    currency_code: row.currency_code as FxSourceCurrency,
    id: row.id as string,
    margin_multiplier: Number(row.margin_multiplier),
    nbp_rate: Number(row.nbp_rate),
    price_id: row.price_id as string,
    source_pln_amount: Number(row.source_pln_amount),
    variant_id: row.variant_id as string,
  };
}

export interface RecordManagedPriceInput {
  variantId: string;
  currencyCode: FxSourceCurrency;
  priceId: string;
  amount: number;
  sourcePlnAmount: number;
  nbpRate: number;
  marginMultiplier: number;
}

/**
 * Module service for the fx-pricing module. Deliberately has no knowledge of
 * the Pricing or Product modules beyond the plain `variant_id`/`price_id`
 * text columns on `FxManagedPrice` - resolving a variant's price set,
 * reading/writing the actual `Price` rows, and calling the NBP API are all
 * orchestration work done in `src/workflows` and `src/jobs`, which is where
 * cross-module and I/O-heavy work belongs. This keeps the module portable
 * and testable in isolation, the same separation `medusa-product-costs`
 * uses.
 */
class FxPricingModuleService extends MedusaService({
  FxManagedPrice,
  FxPricingSettings,
}) {
  protected readonly moduleOptions_: ResolvedFxPricingModuleOptions;

  constructor(container: InjectedDependencies, options?: FxPricingModuleOptions) {
    super(...arguments);
    this.moduleOptions_ = resolveModuleOptions(options);
  }

  /**
   * The plugin options as configured in `medusa-config.ts`, unaffected by
   * anything saved through Settings > FX pricing. Most callers want
   * `getResolvedRuntimeOptions()` instead.
   */
  get moduleOptions(): ResolvedFxPricingModuleOptions {
    return this.moduleOptions_;
  }

  // ─── Settings singleton ───

  /**
   * The settings singleton, created on first read with `enabled` seeded from
   * `moduleOptions.enabled` (itself defaulting to `false`) and both override
   * columns `null`. A concurrent first-read that loses the insert re-reads
   * the winner's row rather than duplicating it.
   */
  async getSettings(): Promise<FxPricingSettingsRow> {
    const existing = await this.readSettingsRow();
    if (existing) {
      return existing;
    }
    try {
      const [created] = await this.createFxPricingSettings([
        {
          enabled: this.moduleOptions_.enabled,
          id: FX_PRICING_SETTINGS_ID,
          last_run_at: null,
          last_run_summary: null,
          margin_multiplier: null,
          staleness_tolerance_hours: null,
        },
      ]);
      return toSettingsDTO(created as unknown as Record<string, unknown>);
    } catch (error) {
      const row = await this.readSettingsRow();
      if (row) {
        return row;
      }
      throw error;
    }
  }

  protected async readSettingsRow(): Promise<FxPricingSettingsRow | undefined> {
    const [row] = await this.listFxPricingSettings({ id: FX_PRICING_SETTINGS_ID }, { take: 1 });
    return row ? toSettingsDTO(row as unknown as Record<string, unknown>) : undefined;
  }

  /**
   * Save an override for one or more settings. Only the keys present in
   * `patch` are written. Passing `margin_multiplier`/`staleness_tolerance_hours`
   * as `null` explicitly clears that override back to the `medusa-config.ts`
   * default.
   */
  async updateSettings(patch: FxPricingSettingsPatch): Promise<FxPricingSettingsRow> {
    await this.getSettings();
    await this.updateFxPricingSettings({ id: FX_PRICING_SETTINGS_ID, ...patch });
    const row = await this.readSettingsRow();
    if (!row) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "medusa-fx-pricing: the settings singleton disappeared between write and read.",
      );
    }
    return row;
  }

  /**
   * Record a finished run's summary. Called by the job and by the manual
   * "recompute now" route after every run, successful or not, so Settings >
   * FX pricing always shows the most recent attempt.
   */
  async recordRunSummary(summary: RunSummary): Promise<void> {
    await this.getSettings();
    await this.updateFxPricingSettings({
      id: FX_PRICING_SETTINGS_ID,
      last_run_at: new Date(),
      last_run_summary: summary,
    });
  }

  /**
   * The configuration every runtime read of margin/staleness-tolerance
   * should actually use, plus the fully-resolved enabled precedence
   * (`persistedEnabled && !forceDisabled`). This is what the job, the manual
   * action, and the admin config route all resolve against - never
   * `moduleOptions_` directly - so a Settings > FX pricing change takes
   * effect on the very next run, no restart.
   */
  async getResolvedRuntimeOptions(): Promise<ResolvedRuntimeOptions> {
    const settings = await this.getSettings();
    const forceDisabled = isEnvForceDisabled();
    return {
      effectiveEnabled: resolveEffectiveEnabled(settings.enabled, forceDisabled),
      forceDisabled,
      marginMultiplier: settings.margin_multiplier ?? this.moduleOptions_.marginMultiplier,
      persistedEnabled: settings.enabled,
      stalenessToleranceHours:
        settings.staleness_tolerance_hours ?? this.moduleOptions_.stalenessToleranceHours,
    };
  }

  // ─── Managed-price ownership tracking ───

  /** This plugin's tracked record for one variant+currency, if it has ever written one. */
  async getManagedPrice(
    variantId: string,
    currencyCode: FxSourceCurrency,
  ): Promise<FxManagedPriceRow | undefined> {
    const [row] = await this.listFxManagedPrices(
      { currency_code: currencyCode, variant_id: variantId },
      { order: { computed_at: "DESC" }, take: 1 },
    );
    return row ? toManagedPriceDTO(row as unknown as Record<string, unknown>) : undefined;
  }

  /**
   * Bulk-read tracked records for many variants at once, keyed by
   * `${variant_id}:${currency_code}` - used by the recompute step so a full
   * catalog pass does one query instead of one per variant.
   */
  async getManagedPricesByVariantIds(
    variantIds: string[],
    currencyCode: FxSourceCurrency,
  ): Promise<Map<string, FxManagedPriceRow>> {
    if (variantIds.length === 0) {
      return new Map();
    }
    const rows = await this.listFxManagedPrices({
      currency_code: currencyCode,
      variant_id: variantIds,
    });
    const byVariantId = new Map<string, FxManagedPriceRow>();
    for (const row of rows as unknown as Record<string, unknown>[]) {
      byVariantId.set(row.variant_id as string, toManagedPriceDTO(row));
    }
    return byVariantId;
  }

  /**
   * Create or update this plugin's tracking row for one variant+currency,
   * after successfully writing (or confirming unchanged) the corresponding
   * `Price`. Read-then-write rather than a database upsert - see the model
   * comment on why there is no unique constraint backing this.
   */
  async recordManagedPrice(input: RecordManagedPriceInput): Promise<void> {
    const existing = await this.getManagedPrice(input.variantId, input.currencyCode);
    const payload = {
      amount: input.amount,
      computed_at: new Date(),
      currency_code: input.currencyCode,
      margin_multiplier: input.marginMultiplier,
      nbp_rate: input.nbpRate,
      price_id: input.priceId,
      source_pln_amount: input.sourcePlnAmount,
      variant_id: input.variantId,
    };
    if (existing) {
      await this.updateFxManagedPrices([{ id: existing.id, ...payload }]);
    } else {
      await this.createFxManagedPrices([payload]);
    }
  }

  /**
   * Remove this plugin's tracking row for one variant+currency. Not called
   * from the normal recompute path (a mismatch there is simply reported as
   * `skip: manual-override` and the stale record is left as-is - it no
   * longer matches the live price either way, so it decides nothing) but
   * available for an operator/maintenance script that wants to explicitly
   * "un-adopt" a variant+currency.
   */
  async clearManagedPrice(variantId: string, currencyCode: FxSourceCurrency): Promise<void> {
    const existing = await this.getManagedPrice(variantId, currencyCode);
    if (existing) {
      await this.deleteFxManagedPrices([existing.id]);
    }
  }
}

export default FxPricingModuleService;
