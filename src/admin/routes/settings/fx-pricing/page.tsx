import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Alert, Badge, Button, Container, Heading, Input, Label, Switch, Text, toast } from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { sdk } from "../../../lib/sdk";

interface LiveRateDTO {
  mid: number;
  effectiveDate: string;
  tableNo: string;
}

interface LiveRateErrorDTO {
  error: string;
}

function isRateError(rate: LiveRateDTO | LiveRateErrorDTO): rate is LiveRateErrorDTO {
  return "error" in rate;
}

interface CurrencyRunSummaryDTO {
  /** `false` means the run ended before this currency's turn - not that it was fine. */
  reached: boolean;
  currencyDisabled: boolean;
  rateUnavailable: boolean;
  rateStale: boolean;
  /** What the run intended to write, before it wrote anything. */
  plannedCreates: number;
  plannedUpdates: number;
  /** What actually landed AND was stamped. */
  created: number;
  updated: number;
  unchanged: number;
  skippedManualOverride: number;
  skippedNoPlnPrice: number;
  skippedQuantityTiered: number;
  /** Written but unstamped - this plugin can never touch those prices again. */
  stampFailed: number;
  failed: boolean;
  error?: string;
  rate?: number;
  rateEffectiveDate?: string;
}

interface RunSummaryDTO {
  ranAt: string;
  ran: boolean;
  currencies: Partial<Record<"usd" | "eur", CurrencyRunSummaryDTO>>;
  /** Prices written and stamped across every currency. `0` on a completed run is reported, not hidden. */
  pricesWritten: number;
  error?: string;
  errorName?: string;
  errorStack?: string;
}

interface ConfigResponse {
  effectiveEnabled: boolean;
  forceDisabled: boolean;
  persistedEnabled: boolean;
  /** `null` when no margin is configured anywhere - a run refuses until one is. */
  marginMultiplier: number | null;
  marginMultiplierOverridden: boolean;
  stalenessToleranceHours: number;
  stalenessToleranceHoursOverridden: boolean;
  lastRunAt: string | null;
  lastRunSummary: RunSummaryDTO | null;
  liveRates: Record<"usd" | "eur", LiveRateDTO | LiveRateErrorDTO>;
}

interface RecomputeResponse {
  summary: RunSummaryDTO;
}

const formatDateTime = (value: string | null | undefined, t: (key: string) => string): string => {
  if (!value) {
    return t("fxPricing.dates.never");
  }
  return new Date(value).toLocaleString();
};

const formatRate = (rate: LiveRateDTO | LiveRateErrorDTO | undefined, t: (key: string, options?: Record<string, unknown>) => string): string => {
  if (!rate) {
    return t("fxPricing.rates.loading");
  }
  if (isRateError(rate)) {
    return t("fxPricing.rates.unavailable", { error: rate.error });
  }
  return t("fxPricing.rates.value", { mid: rate.mid.toFixed(4), tableNo: rate.tableNo || "?", effectiveDate: rate.effectiveDate });
};

/**
 * One currency's line in the last-run summary, or in the freshly-returned
 * manual recompute result - same shape, same renderer.
 */
const CurrencySummaryLine = ({
  code,
  summary,
}: {
  code: "USD" | "EUR";
  summary: CurrencyRunSummaryDTO | undefined;
}) => {
  const { t } = useTranslation();
  if (!summary) {
    return (
      <Text className="text-ui-fg-subtle" size="small">
        {t("fxPricing.summary.notPartOfRun", { code })}
      </Text>
    );
  }
  if (summary.reached === false) {
    return (
      <Text className="text-ui-fg-error" size="small">
        {t("fxPricing.summary.notReached", { code })}
      </Text>
    );
  }
  if (summary.failed) {
    return (
      <Text className="text-ui-fg-error" size="small">
        {t("fxPricing.summary.failed", { code, error: summary.error })}
      </Text>
    );
  }
  if (summary.currencyDisabled) {
    return (
      <Text className="text-ui-fg-subtle" size="small">
        {t("fxPricing.summary.currencyDisabled", { code })}
      </Text>
    );
  }
  if (summary.rateUnavailable) {
    return (
      <Text className="text-ui-fg-error" size="small">
        {t("fxPricing.summary.rateUnavailable", { code })}
      </Text>
    );
  }
  if (summary.rateStale) {
    return (
      <Text className="text-ui-fg-error" size="small">
        {t("fxPricing.summary.rateStale", { code, date: summary.rateEffectiveDate })}
      </Text>
    );
  }
  return (
    <>
      <Text className="text-ui-fg-subtle" size="small">
        {t("fxPricing.summary.line", {
          code,
          rate: summary.rate,
          date: summary.rateEffectiveDate,
          created: summary.created,
          plannedCreates: summary.plannedCreates,
          updated: summary.updated,
          plannedUpdates: summary.plannedUpdates,
          unchanged: summary.unchanged,
          skippedManualOverride: summary.skippedManualOverride,
          skippedNoPlnPrice: summary.skippedNoPlnPrice,
          skippedQuantityTiered: summary.skippedQuantityTiered,
        })}
      </Text>
      {summary.stampFailed > 0 ? (
        <Text className="text-ui-fg-error" size="small">
          {t("fxPricing.summary.stampFailed", { code, count: summary.stampFailed })}
        </Text>
      ) : null}
    </>
  );
};

/**
 * A completed run that wrote nothing is the failure mode that looks like
 * success, so it gets a line of its own rather than being left for the reader
 * to infer from a row of zeroes.
 */
const NothingWrittenWarning = ({ summary }: { summary: RunSummaryDTO }) => {
  const { t } = useTranslation();
  if (!summary.ran || summary.error || summary.pricesWritten !== 0) {
    return null;
  }
  return (
    <Text className="text-ui-fg-error" size="small">
      {t("fxPricing.summary.nothingWritten")}
    </Text>
  );
};

/**
 * Settings > FX pricing.
 *
 * Everything store-wide for this plugin lives here: the enabled toggle
 * (persisted, defaults OFF - see the module for why), the margin multiplier
 * and staleness tolerance (persisted overrides of whatever the plugin was
 * installed with), the live NBP rates so an operator can sanity-check what the
 * next run would compute, the last run's summary, and a manual
 * "Recompute now" action for testing a configuration change without waiting
 * for the daily schedule.
 */
const FxPricingSettingsPage = () => {
  const { t } = useTranslation();
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [togglingEnabled, setTogglingEnabled] = useState(false);

  const [marginInput, setMarginInput] = useState("");
  const [stalenessInput, setStalenessInput] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);
  const [resettingConfig, setResettingConfig] = useState(false);

  const [recomputing, setRecomputing] = useState(false);
  const [recomputeResult, setRecomputeResult] = useState<RunSummaryDTO | null>(null);

  const applyConfig = useCallback((response: ConfigResponse) => {
    setConfig(response);
    // A null margin is "not configured", not a value to render - leave the
    // field genuinely empty so it reads as something still to fill in.
    setMarginInput(response.marginMultiplier === null ? "" : String(response.marginMultiplier));
    setStalenessInput(String(response.stalenessToleranceHours));
  }, []);

  const loadConfig = useCallback(() => {
    sdk.client
      .fetch<ConfigResponse>("/admin/fx-pricing/config")
      .then((response) => {
        applyConfig(response);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : t("fxPricing.errors.loadFailed"));
      });
  }, [applyConfig, t]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const toggleEnabled = async (nextEnabled: boolean) => {
    setTogglingEnabled(true);
    try {
      const response = await sdk.client.fetch<ConfigResponse>("/admin/fx-pricing/config", {
        body: { enabled: nextEnabled },
        method: "POST",
      });
      applyConfig(response);
      toast.success(nextEnabled ? t("fxPricing.toasts.enabled") : t("fxPricing.toasts.disabled"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("fxPricing.errors.toggleFailed"));
    } finally {
      setTogglingEnabled(false);
    }
  };

  const saveConfig = async () => {
    const margin = Number.parseFloat(marginInput.replace(",", "."));
    if (!Number.isFinite(margin) || margin <= 0) {
      toast.error(t("fxPricing.errors.marginInvalid"));
      return;
    }
    const staleness = Number.parseInt(stalenessInput, 10);
    if (!Number.isInteger(staleness) || staleness <= 0) {
      toast.error(t("fxPricing.errors.stalenessInvalid"));
      return;
    }
    setSavingConfig(true);
    try {
      const response = await sdk.client.fetch<ConfigResponse>("/admin/fx-pricing/config", {
        body: { margin_multiplier: margin, staleness_tolerance_hours: staleness },
        method: "POST",
      });
      applyConfig(response);
      toast.success(t("fxPricing.toasts.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("fxPricing.errors.saveFailed"));
    } finally {
      setSavingConfig(false);
    }
  };

  const resetConfig = async () => {
    setResettingConfig(true);
    try {
      const response = await sdk.client.fetch<ConfigResponse>("/admin/fx-pricing/config", {
        body: { margin_multiplier: null, staleness_tolerance_hours: null },
        method: "POST",
      });
      applyConfig(response);
      toast.success(t("fxPricing.toasts.cleared"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("fxPricing.errors.resetFailed"));
    } finally {
      setResettingConfig(false);
    }
  };

  const runRecompute = async () => {
    setRecomputing(true);
    setRecomputeResult(null);
    try {
      const response = await sdk.client.fetch<RecomputeResponse>("/admin/fx-pricing/recompute", {
        method: "POST",
      });
      setRecomputeResult(response.summary);
      if (!response.summary.ran) {
        toast.warning(t("fxPricing.toasts.recomputeSkipped"));
      } else if (response.summary.error) {
        toast.error(t("fxPricing.toasts.recomputeError", { error: response.summary.error }));
      } else {
        toast.success(t("fxPricing.toasts.recomputeSuccess"));
      }
      loadConfig();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("fxPricing.errors.recomputeFailed"));
    } finally {
      setRecomputing(false);
    }
  };

  const hasOverride = Boolean(config?.marginMultiplierOverridden || config?.stalenessToleranceHoursOverridden);

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h1">{t("fxPricing.heading")}</Heading>
        <Text className="text-ui-fg-subtle" size="small">
          {t("fxPricing.description")}
        </Text>
      </div>

      {loadError ? (
        <div className="px-6 py-4">
          <Text className="text-ui-fg-error" size="small">
            {loadError}
          </Text>
        </div>
      ) : null}

      <div className="px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <Heading level="h2">{t("fxPricing.enabled.heading")}</Heading>
            <Text className="text-ui-fg-subtle" size="small">
              {t("fxPricing.enabled.description")}
            </Text>
            {config?.forceDisabled ? (
              <Badge className="mt-2" color="orange" size="small">
                {t("fxPricing.enabled.forcedOffBadge")}
              </Badge>
            ) : null}
          </div>
          <Switch
            checked={config?.persistedEnabled ?? false}
            disabled={!config || togglingEnabled || config.forceDisabled}
            onCheckedChange={toggleEnabled}
          />
        </div>
      </div>

      <div className="px-6 py-4">
        <div className="mb-2 flex items-center justify-between">
          <Heading level="h2">{t("fxPricing.configuration.heading")}</Heading>
          {hasOverride ? (
            <Button
              disabled={!config}
              isLoading={resettingConfig}
              onClick={resetConfig}
              size="small"
              variant="secondary"
            >
              {t("fxPricing.configuration.clearButton")}
            </Button>
          ) : null}
        </div>
        {config && config.marginMultiplier === null ? (
          <Alert className="mb-3" variant="warning">
            {t("fxPricing.configuration.noMarginWarning")}
          </Alert>
        ) : null}
        {config ? (
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
            <div className="flex flex-col gap-y-1">
              <Label htmlFor="fx-pricing-margin" size="small">
                {t("fxPricing.configuration.marginLabel")}
              </Label>
              <Input
                autoComplete="off"
                id="fx-pricing-margin"
                onChange={(event) => setMarginInput(event.target.value)}
                placeholder={t("fxPricing.configuration.marginPlaceholder")}
                value={marginInput}
              />
              <Text className="text-ui-fg-subtle" size="xsmall">
                {t("fxPricing.configuration.marginHelp")}
              </Text>
            </div>
            <div className="flex flex-col gap-y-1">
              <Label htmlFor="fx-pricing-staleness" size="small">
                {t("fxPricing.configuration.stalenessLabel")}
              </Label>
              <Input
                autoComplete="off"
                id="fx-pricing-staleness"
                onChange={(event) => setStalenessInput(event.target.value)}
                placeholder="120"
                value={stalenessInput}
              />
              <Text className="text-ui-fg-subtle" size="xsmall">
                {t("fxPricing.configuration.stalenessHelp")}
              </Text>
            </div>
          </div>
        ) : (
          <Text className="text-ui-fg-subtle" size="small">
            {t("fxPricing.loading")}
          </Text>
        )}
        <div className="mt-4">
          <Button disabled={!config} isLoading={savingConfig} onClick={saveConfig}>
            {t("fxPricing.configuration.saveButton")}
          </Button>
        </div>
      </div>

      <div className="px-6 py-4">
        <Heading className="mb-2" level="h2">
          {t("fxPricing.rates.heading")}
        </Heading>
        <Text className="text-ui-fg-subtle" size="small">
          {t("fxPricing.rates.usdLine", { rate: formatRate(config?.liveRates.usd, t) })}
        </Text>
        <Text className="text-ui-fg-subtle" size="small">
          {t("fxPricing.rates.eurLine", { rate: formatRate(config?.liveRates.eur, t) })}
        </Text>
      </div>

      <div className="px-6 py-4">
        <div className="mb-2 flex items-center justify-between">
          <Heading level="h2">{t("fxPricing.lastRun.heading")}</Heading>
          <Button isLoading={recomputing} onClick={runRecompute} size="small">
            {t("fxPricing.lastRun.recomputeButton")}
          </Button>
        </div>
        <Text className="text-ui-fg-subtle mb-2" size="small">
          {t("fxPricing.lastRun.lastFinished", { date: formatDateTime(config?.lastRunAt, t) })}
        </Text>
        {config?.lastRunSummary ? (
          <div className="flex flex-col gap-y-1">
            <CurrencySummaryLine code="USD" summary={config.lastRunSummary.currencies.usd} />
            <CurrencySummaryLine code="EUR" summary={config.lastRunSummary.currencies.eur} />
            <NothingWrittenWarning summary={config.lastRunSummary} />
            {config.lastRunSummary.error ? (
              <Text className="text-ui-fg-error" size="small">
                {t("fxPricing.lastRun.runError", { error: config.lastRunSummary.error })}
              </Text>
            ) : null}
          </div>
        ) : (
          <Text className="text-ui-fg-subtle" size="small">
            {t("fxPricing.lastRun.none")}
          </Text>
        )}

        {recomputeResult ? (
          <div className="mt-4 flex flex-col gap-y-1 border-t pt-4">
            <Text className="font-medium" size="small">
              {t("fxPricing.lastRun.justNow")}
            </Text>
            <CurrencySummaryLine code="USD" summary={recomputeResult.currencies.usd} />
            <CurrencySummaryLine code="EUR" summary={recomputeResult.currencies.eur} />
            <NothingWrittenWarning summary={recomputeResult} />
          </div>
        ) : null}
      </div>
    </Container>
  );
};

export const config = defineRouteConfig({
  // A translation key, not a literal: the dashboard resolves it with
  // `t(label, { ns: translationNs })`. This plugin registers its strings in the
  // default `translation` namespace, and the dashboard's `fallbackNS` is that
  // namespace, so the prefixed key resolves through it. The settings entry and the
  // page heading deliberately read the same key and cannot drift apart.
  label: "fxPricing.heading",
  translationNs: "fxPricing",
});

export default FxPricingSettingsPage;
