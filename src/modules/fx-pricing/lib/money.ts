/**
 * Money/number helpers for the fx-pricing module. Centralized so the
 * rounding strategy never drifts between the compute step, the manual
 * "recompute now" action, and the tests.
 */

/**
 * Round to 2 decimal places, half-up. Uses `Number.EPSILON` to bias the
 * binary floating-point representation away from the tie-to-even direction,
 * so values like `1.005` round to `1.01` instead of `1.00`.
 */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
