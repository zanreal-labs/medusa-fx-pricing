/**
 * NBP (Narodowy Bank Polski, the Polish central bank) table A exchange-rate
 * lookup. Table A is published once per business day and carries the "mid"
 * (average) rate this plugin uses as the market rate before the configured
 * margin is applied.
 *
 * On a weekend or a Polish public holiday, NBP does not publish a new table
 * - the `/rates/a/<code>/` endpoint used here (no date suffix) always
 * answers with the most recently published table, so "use the latest
 * available rate" (the spec's requirement for handling non-publishing days)
 * is the endpoint's default behavior, not something this module has to
 * special-case. `effectiveDate` on the response is how a caller notices the
 * rate is a few days old - see `isRateStale` below.
 */

export type FxSourceCurrency = "usd" | "eur";

/** One parsed NBP table A rate, ready for `computeForeignAmount`. */
export interface NbpRate {
  currency: FxSourceCurrency;
  /** PLN per 1 unit of `currency` - the table A "mid" rate. */
  mid: number;
  /** The date NBP published this rate for, as `YYYY-MM-DD`. */
  effectiveDate: string;
  /** NBP's own table number, e.g. `"154/A/NBP/2026"` - kept for audit/debugging only. */
  tableNo: string;
}

const NBP_BASE_URL = "https://api.nbp.pl/api/exchangerates/rates/a";

/**
 * Parse the JSON body of `GET /api/exchangerates/rates/a/<code>/` into an
 * `NbpRate`. Separated from the fetch below so the parsing/validation logic
 * - the part actually worth unit-testing - never needs a real network call
 * or a mocked `fetch` to exercise.
 *
 * Throws a plain `Error` (not a Medusa-specific one - this module has no
 * framework dependency) with a message naming what was wrong, on anything
 * that does not match the expected shape: NBP is a stable, documented
 * public API, so a shape mismatch here means something is actually broken
 * (an outage serving an HTML error page, a breaking API change) rather than
 * a case worth silently tolerating.
 */
export function parseNbpRatesResponse(json: unknown, currency: FxSourceCurrency): NbpRate {
  if (typeof json !== "object" || json === null) {
    throw new Error(`NBP response for ${currency} was not a JSON object`);
  }
  const body = json as Record<string, unknown>;
  const rates = body.rates;
  if (!Array.isArray(rates) || rates.length === 0) {
    throw new Error(`NBP response for ${currency} had no "rates" entries`);
  }
  // Table A carries one rate per response (the latest, absent a date suffix
  // on the request) - the first entry is the one NBP intends as current.
  const latest = rates[0] as Record<string, unknown>;
  const mid = latest.mid;
  const effectiveDate = latest.effectiveDate;
  const tableNo = latest.no;
  if (typeof mid !== "number" || !Number.isFinite(mid) || mid <= 0) {
    throw new Error(`NBP response for ${currency} had a non-numeric or non-positive "mid" rate`);
  }
  if (typeof effectiveDate !== "string" || !effectiveDate) {
    throw new Error(`NBP response for ${currency} was missing "effectiveDate"`);
  }
  return {
    currency,
    effectiveDate,
    mid,
    tableNo: typeof tableNo === "string" ? tableNo : "",
  };
}

/**
 * Fetch and parse the latest NBP table A rate for `currency`. `fetchImpl` is
 * injectable (defaults to the global `fetch`) purely so this can be exercised
 * in a test without a real network call; production code never needs to pass it.
 */
export async function fetchNbpRate(
  currency: FxSourceCurrency,
  fetchImpl: typeof fetch = fetch,
): Promise<NbpRate> {
  const response = await fetchImpl(`${NBP_BASE_URL}/${currency}/`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`NBP request for ${currency} failed with status ${response.status}`);
  }
  const json = await response.json();
  return parseNbpRatesResponse(json, currency);
}

/**
 * Whether `rate` is older than `toleranceHours` relative to `now`.
 *
 * `effectiveDate` is a calendar date with no time-of-day component (NBP
 * publishes once per business day), so it is compared as midnight UTC of
 * that date - a same-day rate is therefore never stale regardless of what
 * time the job runs, and staleness only starts accruing from the day
 * boundary, not from a fixed "hours since publish" instant that does not
 * exist for a date-only value.
 */
export function isRateStale(rate: Pick<NbpRate, "effectiveDate">, now: Date, toleranceHours: number): boolean {
  const effective = new Date(`${rate.effectiveDate}T00:00:00.000Z`);
  if (Number.isNaN(effective.getTime())) {
    // An unparsable date is treated as stale - fail closed rather than
    // silently treating a malformed value as fresh.
    return true;
  }
  const ageHours = (now.getTime() - effective.getTime()) / (1000 * 60 * 60);
  return ageHours > toleranceHours;
}
