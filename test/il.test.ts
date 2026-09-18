import { describe, it, expect } from "vitest";
import {
  validateInput,
  ilFullRange,
  ilConcentrated,
  feeApr,
  estimateIL,
  InputError,
} from "../src/il";

const approx = (v: number, digits = 4) => Number(v.toFixed(digits));

describe("ilFullRange — closed-form known cases", () => {
  it("price unchanged -> 0 IL", () => {
    expect(ilFullRange(1)).toBeCloseTo(0, 12);
  });
  it("2x price move -> IL ≈ -5.725%", () => {
    // 2*sqrt(2)/3 - 1 = -0.0571909584
    expect(ilFullRange(2)).toBeCloseTo(-0.0571909584, 8);
  });
  it("symmetric: 0.5x move -> same IL as 2x", () => {
    expect(ilFullRange(0.5)).toBeCloseTo(ilFullRange(2), 12);
  });
  it("4x price move -> IL = -20%", () => {
    // 2*2/5 - 1 = -0.2
    expect(ilFullRange(4)).toBeCloseTo(-0.2, 12);
  });
  it("10x price move -> IL ≈ -42.50%", () => {
    expect(ilFullRange(10)).toBeCloseTo(2 * Math.sqrt(10) / 11 - 1, 12);
    expect(approx(ilFullRange(10) * 100, 2)).toBe(-42.5);
  });
  it("rejects non-positive price ratios", () => {
    expect(() => ilFullRange(0)).toThrow(InputError);
    expect(() => ilFullRange(-2)).toThrow(InputError);
  });
});

describe("ilFullRange — Balancer-style weighted pools", () => {
  it("50/50 matches the standard formula", () => {
    expect(ilFullRange(2, 0.5, 0.5)).toBeCloseTo(ilFullRange(2), 12);
  });
  it("80/20 pool, 2x move -> IL ≈ -4.28%", () => {
    // 2^0.2 / (0.8 + 0.2*2) - 1
    const expected = Math.pow(2, 0.2) / 1.2 - 1;
    expect(ilFullRange(2, 0.8, 0.2)).toBeCloseTo(expected, 12);
    expect(approx(expected * 100, 2)).toBe(-4.28);
  });
  it("weighted pool always has less |IL| than 50/50 for the same move", () => {
    expect(Math.abs(ilFullRange(3, 0.8, 0.2))).toBeLessThan(Math.abs(ilFullRange(3, 0.5, 0.5)));
  });
});

describe("ilConcentrated — Uniswap V3 ranges", () => {
  it("very wide range converges to full-range IL", () => {
    const wide = ilConcentrated(2, 1e-6, 1e6);
    expect(wide).toBeCloseTo(ilFullRange(2), 3);
  });
  it("narrow range amplifies IL vs full range", () => {
    // p=1.5 exits [0.9,1.1] -> clamped at boundary: still far more negative
    const narrow = ilConcentrated(1.5, 0.9, 1.1);
    expect(narrow).toBeLessThan(ilFullRange(1.5)); // more negative
    expect(narrow).toBeCloseTo(-0.1734, 3);
  });
  it("in-range narrow move amplifies IL vs full range", () => {
    const narrow = ilConcentrated(1.05, 0.9, 1.1); // stays in range
    expect(narrow).toBeLessThan(ilFullRange(1.05));
  });
  it("no price move -> 0 IL even concentrated", () => {
    expect(ilConcentrated(1, 0.8, 1.2)).toBeCloseTo(0, 12);
  });
  it("rejects degenerate ranges", () => {
    expect(() => ilConcentrated(2, 1.2, 0.8)).toThrow(InputError);
    expect(() => ilConcentrated(2, -1, 2)).toThrow(InputError);
  });
});

describe("feeApr", () => {
  it("computes annualized fee APR from window volume", () => {
    // $1M daily volume, 0.3% tier, $10M TVL -> daily fees $3k -> APR = 3000*365/10M = 10.95%
    expect(feeApr(1_000_000, 30, 10_000_000, 24)).toBeCloseTo(0.1095, 6);
  });
  it("scales with window length", () => {
    expect(feeApr(2_000_000, 30, 10_000_000, 48)).toBeCloseTo(feeApr(1_000_000, 30, 10_000_000, 24), 12);
  });
});

describe("validateInput", () => {
  const base = {
    pool_address: "83vF4CZFv8y2y3pG9H1x7K2nM5qR8tY6wE4rT1uI0oP",
    window_hours: 168,
    price_start: 3000,
    price_end: 3300,
  };
  it("accepts a minimal valid body", () => {
    const v = validateInput(base);
    expect(v.amm).toBe("uniswap-v2");
    expect(v.token_weights).toEqual([0.5, 0.5]);
  });
  it("rejects missing pool_address", () => {
    expect(() => validateInput({ ...base, pool_address: undefined })).toThrow(InputError);
  });
  it("rejects weights not summing to 1", () => {
    expect(() => validateInput({ ...base, token_weights: [0.6, 0.6] })).toThrow(InputError);
  });
  it("rejects bad window_hours", () => {
    expect(() => validateInput({ ...base, window_hours: -5 })).toThrow(InputError);
    expect(() => validateInput({ ...base, window_hours: 0 })).toThrow(InputError);
  });
  it("rejects unknown amm", () => {
    expect(() => validateInput({ ...base, amm: "pancakeswap" })).toThrow(InputError);
  });
  it("rejects non-positive prices", () => {
    expect(() => validateInput({ ...base, price_start: 0 })).toThrow(InputError);
  });
  it("rejects half-provided v3 range", () => {
    expect(() => validateInput({ ...base, amm: "uniswap-v3", range_lower: 0.9 })).toThrow(InputError);
  });
  it("rejects inverted v3 range", () => {
    expect(() => validateInput({ ...base, amm: "uniswap-v3", range_lower: 1.1, range_upper: 0.9 })).toThrow(InputError);
  });
});

describe("estimateIL — output contract (bounty spec)", () => {
  it("returns IL_percent, fee_apr_est, volume_window, notes", () => {
    const input = validateInput({
      pool_address: "pool1234567890",
      window_hours: 24,
      price_start: 100,
      price_end: 200,
      fee_tier_bps: 30,
      volume_window_usd: 1_000_000,
      tvl_usd: 10_000_000,
    });
    const out = estimateIL(input, 2);
    expect(out.IL_percent).toBeCloseTo(-5.71909584, 6);
    expect(out.fee_apr_est).toBeCloseTo(0.1095, 6);
    expect(out.volume_window).toBe(1_000_000);
    expect(Array.isArray(out.notes) && out.notes.length > 0).toBe(true);
    expect(out.inputs_echo.price_ratio).toBe(2);
  });
  it("fee_apr_est is null (honest) when volume/tvl missing", () => {
    const input = validateInput({ pool_address: "pool1234567890", window_hours: 24, price_start: 100, price_end: 110 });
    const out = estimateIL(input, 1.1);
    expect(out.fee_apr_est).toBeNull();
    expect(out.volume_window).toBeNull();
    expect(out.notes.join(" ").toLowerCase()).toContain("never invents");
  });
});
