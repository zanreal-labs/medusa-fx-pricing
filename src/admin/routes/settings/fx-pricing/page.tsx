import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Alert, Badge, Button, Container, Heading, Input, Label, Switch, Text, toast } from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
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
  currencyDisabled: boolean;
  rateUnavailable: boolean;
  rateStale: boolean;
  created: number;
  updated: number;
  unchanged: number;
  skippedManualOverride: number;
  skippedNoPlnPrice: number;
  rate?: number;
  rateEffectiveDate?: string;
}

interface RunSummaryDTO {
  ranAt: string;
  ran: boolean;
  currencies: Partial<Record<"usd" | "eur", CurrencyRunSummaryDTO>>;
  error?: string;
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

const formatDateTime = (value: string | null | undefined): string => {
  if (!value) {
    return "never";
  }
  return new Date(value).toLocaleString();
};

const formatRate = (rate: LiveRateDTO | LiveRateErrorDTO | undefined): string => {
  if (!rate) {
    return "loading...";
  }
  if (isRateError(rate)) {
    return `unavailable (${rate.error})`;
  }
  return `${rate.mid.toFixed(4)} PLN (table ${rate.tableNo || "?"}, ${rate.effectiveDate})`;
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
  if (!summary) {
    return (
      <Text className="text-ui-fg-subtle" size="small">
        {code}: not part of this run
      </Text>
    );
  }
  if (summary.currencyDisabled) {
    return (
      <Text className="text-ui-fg-subtle" size="small">
        {code}: skipped - not enabled in the store's supported currencies
      </Text>
    );
  }
  if (summary.rateUnavailable) {
    return (
      <Text className="text-ui-fg-error" size="small">
        {code}: skipped - the NBP rate could not be fetched
      </Text>
    );
  }
  if (summary.rateStale) {
    return (
      <Text className="text-ui-fg-error" size="small">
        {code}: skipped - the latest NBP rate ({summary.rateEffectiveDate}) is older than the
        staleness tolerance
      </Text>
    );
  }
  return (
    <Text className="text-ui-fg-subtle" size="small">
      {code}: rate {summary.rate} ({summary.rateEffectiveDate}) - created {summary.created},
      updated {summary.updated}, unchanged {summary.unchanged}, manual overrides skipped{" "}
      {summary.skippedManualOverride}, no PLN price {summary.skippedNoPlnPrice}
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
        setLoadError(error instanceof Error ? error.message : "Could not load configuration.");
      });
  }, [applyConfig]);

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
      toast.success(nextEnabled ? "FX pricing enabled." : "FX pricing disabled.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the toggle.");
    } finally {
      setTogglingEnabled(false);
    }
  };

  const saveConfig = async () => {
    const margin = Number.parseFloat(marginInput.replace(",", "."));
    if (!Number.isFinite(margin) || margin <= 0) {
      toast.error("Enter a margin multiplier greater than 0, e.g. 1.10 for a 10% margin.");
      return;
    }
    const staleness = Number.parseInt(stalenessInput, 10);
    if (!Number.isInteger(staleness) || staleness <= 0) {
      toast.error("Enter a staleness tolerance in whole hours, greater than 0.");
      return;
    }
    setSavingConfig(true);
    try {
      const response = await sdk.client.fetch<ConfigResponse>("/admin/fx-pricing/config", {
        body: { margin_multiplier: margin, staleness_tolerance_hours: staleness },
        method: "POST",
      });
      applyConfig(response);
      toast.success("Saved. The next run - scheduled or manual - uses this. No restart needed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the configuration.");
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
      toast.success("Cleared. Both settings fall back to whatever this plugin was installed with.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reset the configuration.");
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
        toast.warning("Nothing ran - FX pricing is disabled.");
      } else if (response.summary.error) {
        toast.error(`Run finished with an error: ${response.summary.error}`);
      } else {
        toast.success("Recompute finished. See the summary below.");
      }
      loadConfig();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Recompute failed.");
    } finally {
      setRecomputing(false);
    }
  };

  const hasOverride = Boolean(config?.marginMultiplierOverridden || config?.stalenessToleranceHoursOverridden);

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h1">FX pricing</Heading>
        <Text className="text-ui-fg-subtle" size="small">
          Derives USD and EUR variant prices from the native PLN selling price, using the NBP
          (Polish central bank) table A mid rate plus a configurable margin. Runs daily; manual
          price edits are never overwritten - see the README for how that is guaranteed.
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
            <Heading level="h2">Enabled</Heading>
            <Text className="text-ui-fg-subtle" size="small">
              Off by default. While off, the daily job and the manual recompute below both no-op.
            </Text>
            {config?.forceDisabled ? (
              <Badge className="mt-2" color="orange" size="small">
                Forced off by FX_PRICING_DISABLED in the environment
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
          <Heading level="h2">Configuration</Heading>
          {hasOverride ? (
            <Button
              disabled={!config}
              isLoading={resettingConfig}
              onClick={resetConfig}
              size="small"
              variant="secondary"
            >
              Clear saved values
            </Button>
          ) : null}
        </div>
        {config && config.marginMultiplier === null ? (
          <Alert className="mb-3" variant="warning">
            No margin multiplier is set, so recompute runs refuse and no price is written. This
            plugin ships without a default margin on purpose - it will not guess a markup for your
            store. Set one below to start pricing.
          </Alert>
        ) : null}
        {config ? (
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
            <div className="flex flex-col gap-y-1">
              <Label htmlFor="fx-pricing-margin" size="small">
                Margin multiplier
              </Label>
              <Input
                autoComplete="off"
                id="fx-pricing-margin"
                onChange={(event) => setMarginInput(event.target.value)}
                placeholder="e.g. 1.25"
                value={marginInput}
              />
              <Text className="text-ui-fg-subtle" size="xsmall">
                foreign_amount = pln_amount / nbp_rate * margin_multiplier. Use 1 for no markup,
                1.25 for 25% on top of the raw NBP mid rate. Required: while this is blank, runs
                refuse rather than guess a markup.
              </Text>
            </div>
            <div className="flex flex-col gap-y-1">
              <Label htmlFor="fx-pricing-staleness" size="small">
                Rate staleness tolerance (hours)
              </Label>
              <Input
                autoComplete="off"
                id="fx-pricing-staleness"
                onChange={(event) => setStalenessInput(event.target.value)}
                placeholder="120"
                value={stalenessInput}
              />
              <Text className="text-ui-fg-subtle" size="xsmall">
                If the latest published NBP rate is older than this, that currency is skipped for
                the run instead of pricing off a stale rate.
              </Text>
            </div>
          </div>
        ) : (
          <Text className="text-ui-fg-subtle" size="small">
            Loading...
          </Text>
        )}
        <div className="mt-4">
          <Button disabled={!config} isLoading={savingConfig} onClick={saveConfig}>
            Save
          </Button>
        </div>
      </div>

      <div className="px-6 py-4">
        <Heading className="mb-2" level="h2">
          Current NBP rates
        </Heading>
        <Text className="text-ui-fg-subtle" size="small">
          USD: {formatRate(config?.liveRates.usd)}
        </Text>
        <Text className="text-ui-fg-subtle" size="small">
          EUR: {formatRate(config?.liveRates.eur)}
        </Text>
      </div>

      <div className="px-6 py-4">
        <div className="mb-2 flex items-center justify-between">
          <Heading level="h2">Last run</Heading>
          <Button isLoading={recomputing} onClick={runRecompute} size="small">
            Recompute now
          </Button>
        </div>
        <Text className="text-ui-fg-subtle mb-2" size="small">
          Last finished: {formatDateTime(config?.lastRunAt)}
        </Text>
        {config?.lastRunSummary ? (
          <div className="flex flex-col gap-y-1">
            <CurrencySummaryLine code="USD" summary={config.lastRunSummary.currencies.usd} />
            <CurrencySummaryLine code="EUR" summary={config.lastRunSummary.currencies.eur} />
            {config.lastRunSummary.error ? (
              <Text className="text-ui-fg-error" size="small">
                Run error: {config.lastRunSummary.error}
              </Text>
            ) : null}
          </div>
        ) : (
          <Text className="text-ui-fg-subtle" size="small">
            No run recorded yet.
          </Text>
        )}

        {recomputeResult ? (
          <div className="mt-4 flex flex-col gap-y-1 border-t pt-4">
            <Text className="font-medium" size="small">
              Just now:
            </Text>
            <CurrencySummaryLine code="USD" summary={recomputeResult.currencies.usd} />
            <CurrencySummaryLine code="EUR" summary={recomputeResult.currencies.eur} />
          </div>
        ) : null}
      </div>
    </Container>
  );
};

export const config = defineRouteConfig({
  label: "FX pricing",
});

export default FxPricingSettingsPage;
