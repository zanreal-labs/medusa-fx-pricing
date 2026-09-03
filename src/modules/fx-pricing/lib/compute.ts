import { round2 } from "./money";

/**
 * How to reduce the PLN source amount to the net base this plugin's
 * conversion is actually supposed to run from - see AI-655.
 *
 * `EUR`/`USD` default prices on this store are configured as **netto**
 * (`price_preference.is_tax_inclusive: false`), while the `PLN` default price
 * is **brutto** (`is_tax_inclusive: true`, 23% VAT). Feeding a gross PLN
 * amount straight into `pln_amount / nbp_rate * margin_multiplier` therefore
 * writes a gross amount into a field the store itself declares net - a
 * config-invisible 23% on top of whatever `marginMultiplier` says, discovered
 * when a `1.1` margin landed as an effective ~1.353 in production. See
 * `FxPricingModuleOptions.sourcePriceIncludesVat`.
 */
export interface VatAdjustment {
  /** Whether `plnAmount` includes VAT and must be reduced to net before conversion. */
  sourceIncludesVat: boolean;
  /** The VAT rate to strip, e.g. `0.23` for 23%. Ignored when `sourceIncludesVat` is `false`. */
  vatRate: number;
}

/**
 * Reduce a PLN amount to the net base the FX conversion should run from.
 *
 * Returns `plnAmount` unchanged when `vatAdjustment` is omitted or
 * `sourceIncludesVat` is `false` - the pre-AI-655 behavior, and what a store
 * whose PLN default price is already netto should get. Returns `undefined`
 * for a `vatRate` that cannot produce a real net amount (non-finite, or
 * `<= -1`, which would divide by zero or flip the sign) rather than a guessed
 * value - the same "no silent fallback" rule `computeForeignAmount` itself
 * follows.
 */
export function toNetPlnAmount(plnAmount: number, vatAdjustment?: VatAdjustment): number | undefined {
  if (!vatAdjustment || !vatAdjustment.sourceIncludesVat) {
    return plnAmount;
  }
  const { vatRate } = vatAdjustment;
  if (!Number.isFinite(vatRate) || vatRate <= -1) {
    return undefined;
  }
  return plnAmount / (1 + vatRate);
}

/**
 * The pure margin math this whole plugin exists to apply:
 *
 *   net_pln_amount = sourceIncludesVat ? pln_amount / (1 + vat_rate) : pln_amount
 *   foreign_amount = net_pln_amount / nbp_rate * margin_multiplier
 *
 * `nbp_rate` is the NBP table A mid rate (PLN per 1 unit of the foreign
 * currency), so dividing the (net) PLN amount by it converts to the foreign
 * currency at the raw market mid rate, and `margin_multiplier` then grosses
 * that up (1.10 = 10% on top, the plugin's default). The VAT step runs first
 * and only when `vatAdjustment.sourceIncludesVat` is true - see
 * `toNetPlnAmount` and `VatAdjustment`.
 *
 * Rounded half-up to 2 decimal places, matching every other money value in
 * this plugin - see `round2`.
 *
 * Returns `undefined` rather than a nonsense number for any input that
 * cannot produce a real price: a non-finite or non-positive PLN amount, a
 * non-finite or non-positive rate, a non-finite or non-positive margin, or a
 * `vatAdjustment` that cannot produce a real net amount. There is no silent
 * fallback to `0` or `1` here - an unresolvable input means the caller skips
 * that variant/currency for this run rather than writing a wrong price.
 */
export function computeForeignAmount(
  plnAmount: number,
  nbpRate: number,
  marginMultiplier: number,
  vatAdjustment?: VatAdjustment,
): number | undefined {
  if (!Number.isFinite(plnAmount) || plnAmount <= 0) {
    return undefined;
  }
  if (!Number.isFinite(nbpRate) || nbpRate <= 0) {
    return undefined;
  }
  if (!Number.isFinite(marginMultiplier) || marginMultiplier <= 0) {
    return undefined;
  }
  const netPlnAmount = toNetPlnAmount(plnAmount, vatAdjustment);
  if (netPlnAmount === undefined || !Number.isFinite(netPlnAmount) || netPlnAmount <= 0) {
    return undefined;
  }
  return round2((netPlnAmount / nbpRate) * marginMultiplier);
}
