import { round2 } from "./money";

/**
 * The pure margin math this whole plugin exists to apply:
 *
 *   foreign_amount = pln_amount / nbp_rate * margin_multiplier
 *
 * `nbp_rate` is the NBP table A mid rate (PLN per 1 unit of the foreign
 * currency), so dividing the PLN amount by it converts to the foreign
 * currency at the raw market mid rate, and `margin_multiplier` then grosses
 * that up (1.10 = 10% on top, the plugin's default).
 *
 * Rounded half-up to 2 decimal places, matching every other money value in
 * this plugin - see `round2`.
 *
 * Returns `undefined` rather than a nonsense number for any input that
 * cannot produce a real price: a non-finite or non-positive PLN amount, a
 * non-finite or non-positive rate, or a non-finite or non-positive margin.
 * There is no silent fallback to `0` or `1` here - an unresolvable input
 * means the caller skips that variant/currency for this run rather than
 * writing a wrong price.
 */
export function computeForeignAmount(
  plnAmount: number,
  nbpRate: number,
  marginMultiplier: number,
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
  return round2((plnAmount / nbpRate) * marginMultiplier);
}
