import { describe, expect, it } from "vitest";
import { round2 } from "../money";

describe("round2", () => {
  it("rounds to 2 decimal places", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(1.004)).toBe(1);
    expect(round2(10)).toBe(10);
  });

  it("rounds half-up rather than tie-to-even", () => {
    // 0.135 in binary floating point is actually slightly below the exact
    // value, so a naive Math.round would land on 0.13 - the EPSILON bias in
    // round2 pulls it to the intended 0.14.
    expect(round2(0.135)).toBe(0.14);
  });

  it("handles negative numbers", () => {
    expect(round2(-1.005)).toBe(-1);
  });
});
