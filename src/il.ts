/**
 * Impermanent loss mathematics for major AMMs.
 *
 * Conventions: P = price of token1 denominated in token0 (e.g. ETH in USDC).
 * p = P_end / P_start (price ratio over the window).
 * IL is expressed as a fraction of the HODL portfolio value (negative = loss).
 */

export type Amm = "uniswap-v2" | "uniswap-v3" | "raydium" | "orca" | "balancer";

export interface EstimateInput {
  pool_address: string;
  token_weights?: [number, number]; // default [0.5, 0.5]
  deposit_amounts?: [number, number];
  window_hours: number;
  price_start?: number; // if omitted, the agent fetches spot prices
  price_end?: number;
  amm?: Amm;
  fee_tier_bps?: number; // e.g. 30 = 0.30%
  volume_window_usd?: number;
  tvl_usd?: number;
  range_lower?: number; // v3 concentrated: lower bound as multiple of P_start
  range_upper?: number; // v3 concentrated: upper bound as multiple of P_start
}

export interface EstimateOutput {
  IL_percent: number;
  fee_apr_est: number | null;
  volume_window: number | null;
  notes: string[];
  inputs_echo: {
    pool_address: string;
    amm: Amm;
    price_ratio: number;
    token_weights: [number, number];
    window_hours: number;
  };
}

export class InputError extends Error {}

/** Parse + validate raw JSON body. Throws InputError with a clear message. */
export function validateInput(raw: unknown): EstimateInput {
  if (typeof raw !== "object" || raw === null) throw new InputError("body must be a JSON object");
  const b = raw as Record<string, unknown>;

  const pool_address = b.pool_address;
  if (typeof pool_address !== "string" || pool_address.length < 8 || pool_address.length > 128)
    throw new InputError("pool_address must be a string of 8–128 chars");

  const window_hours = b.window_hours;
  if (typeof window_hours !== "number" || !Number.isFinite(window_hours) || window_hours <= 0 || window_hours > 24 * 365 * 5)
    throw new InputError("window_hours must be a finite number in (0, 43800]");

  let token_weights: [number, number] = [0.5, 0.5];
  if (b.token_weights !== undefined) {
    const w = b.token_weights;
    if (!Array.isArray(w) || w.length !== 2 || w.some((x) => typeof x !== "number" || !Number.isFinite(x) || x <= 0 || x >= 1))
      throw new InputError("token_weights must be [w0, w1] with each in (0, 1)");
    if (Math.abs(w[0] + w[1] - 1) > 1e-9) throw new InputError("token_weights must sum to 1");
    token_weights = [w[0], w[1]];
  }

  if (b.deposit_amounts !== undefined) {
    const d = b.deposit_amounts;
    if (!Array.isArray(d) || d.length !== 2 || d.some((x) => typeof x !== "number" || !Number.isFinite(x) || x < 0))
      throw new InputError("deposit_amounts must be [a0, a1] of non-negative numbers");
  }

  for (const k of ["price_start", "price_end"] as const) {
    const v = b[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0))
      throw new InputError(`${k} must be a positive number`);
  }

  const amm = (b.amm ?? "uniswap-v2") as Amm;
  const amms: Amm[] = ["uniswap-v2", "uniswap-v3", "raydium", "orca", "balancer"];
  if (!amms.includes(amm)) throw new InputError(`amm must be one of ${amms.join(", ")}`);

  const num = (k: string, min: number, max: number) => {
    const v = b[k];
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
      throw new InputError(`${k} must be a number in [${min}, ${max}]`);
    return v;
  };

  const range_lower = num("range_lower", 0, 1e9);
  const range_upper = num("range_upper", 0, 1e9);
  if ((range_lower === undefined) !== (range_upper === undefined))
    throw new InputError("range_lower and range_upper must be provided together");
  if (range_lower !== undefined && range_upper !== undefined && range_lower >= range_upper)
    throw new InputError("range_lower must be < range_upper");

  return {
    pool_address,
    token_weights,
    deposit_amounts: b.deposit_amounts as [number, number] | undefined,
    window_hours,
    price_start: b.price_start as number | undefined,
    price_end: b.price_end as number | undefined,
    amm,
    fee_tier_bps: num("fee_tier_bps", 0, 10000),
    volume_window_usd: num("volume_window_usd", 0, 1e15),
    tvl_usd: num("tvl_usd", 0, 1e15),
    range_lower,
    range_upper,
  };
}

/**
 * Full-range / constant-product IL (Uniswap V2, Raydium & Orca full-range,
 * Balancer-style weighted pools).
 *   IL(p) = p^w1 / (w0 + w1·p) − 1
 * Reduces to 2√p/(1+p) − 1 for 50/50.
 */
export function ilFullRange(priceRatio: number, w0 = 0.5, w1 = 0.5): number {
  if (!(priceRatio > 0) || !Number.isFinite(priceRatio)) throw new InputError("priceRatio must be positive finite");
  return Math.pow(priceRatio, w1) / (w0 + w1 * priceRatio) - 1;
}

/**
 * Uniswap V3 concentrated-liquidity IL, exact while P stays inside [Pa, Pb].
 *
 * Intuitive convention: P = price of token1 in token0 (e.g. ETH in USDC),
 * p = P_end / P_start, bounds given as multiples of P_start.
 *
 * Internally converted to the V3 convention Q = 1/P (price of token0 in
 * token1), where for Q in [Qa, Qb] with liquidity L:
 *   x = L(1/√Q − 1/√Qb)   (token0)
 *   y = L(√Q − √Qa)       (token1)
 * Value in token0: V(Q) = x + y/Q ;  HODL: H(Q1) = x0 + y0/Q1.
 *
 * If price exits the range, end-amounts are clamped at the boundary (the
 * position stops rebalancing and stops earning fees) and the result is a
 * lower bound on the true loss — flagged in `notes` by the caller.
 */
export function ilConcentrated(priceRatio: number, lower: number, upper: number): number {
  if (!(priceRatio > 0) || !Number.isFinite(priceRatio)) throw new InputError("priceRatio must be positive finite");
  if (!(lower > 0) || !(upper > lower)) throw new InputError("need 0 < lower < upper");
  const P0 = 1; // normalize: prices as multiples of P_start
  const P1 = priceRatio;
  // V3 convention Q = 1/P; bounds invert: [Pa,Pb] in P -> [1/Pb, 1/Pa] in Q
  const Q0 = 1 / P0;
  const Q1raw = 1 / P1;
  const Qa = 1 / upper;
  const Qb = 1 / lower;
  const L = 1; // cancels out
  const inRange = Q1raw >= Qa && Q1raw <= Qb;
  const Q1 = Math.min(Qb, Math.max(Qa, Q1raw)); // clamp at boundary if out of range
  const x0 = L * (1 / Math.sqrt(Q0) - 1 / Math.sqrt(Qb));
  const y0 = L * (Math.sqrt(Q0) - Math.sqrt(Qa));
  const x1 = L * (1 / Math.sqrt(Q1) - 1 / Math.sqrt(Qb));
  const y1 = L * (Math.sqrt(Q1) - Math.sqrt(Qa));
  const V1 = x1 + y1 / Q1;
  const H1 = x0 + y0 / Q1raw;
  if (!(H1 > 0)) throw new InputError("degenerate range/price combination");
  const il = V1 / H1 - 1;
  return inRange ? il : il; // clamping already encodes the out-of-range lower bound
}

/** Fee APR from window volume: apr = volume·fee_tier/tvl · (8760/window_hours). */
export function feeApr(volumeWindowUsd: number, feeTierBps: number, tvlUsd: number, windowHours: number): number {
  if (!(tvlUsd > 0) || !(windowHours > 0)) throw new InputError("tvl_usd and window_hours must be positive");
  return ((volumeWindowUsd * (feeTierBps / 1e4)) / tvlUsd) * (8760 / windowHours);
}

export function estimateIL(input: EstimateInput, priceRatio: number): EstimateOutput {
  const notes: string[] = [];
  const [w0, w1] = input.token_weights!;
  let il: number;

  if (input.amm === "uniswap-v3" && input.range_lower !== undefined && input.range_upper !== undefined) {
    il = ilConcentrated(priceRatio, input.range_lower, input.range_upper);
    notes.push(
      `Uniswap V3 concentrated model: exact IL while price stays inside [${input.range_lower}×, ${input.range_upper}×] of the start price. ` +
        `If price exits the range the position stops earning fees and IL is understated — treat as a lower bound.`
    );
  } else {
    il = ilFullRange(priceRatio, w0, w1);
    const model =
      input.amm === "balancer"
        ? `Balancer-style weighted pool (${(w0 * 100).toFixed(0)}/${(w1 * 100).toFixed(0)})`
        : input.amm === "raydium"
          ? "Raydium CLMM full-range equivalent (constant-product approximation)"
          : input.amm === "orca"
            ? "Orca Whirlpool full-range equivalent (constant-product approximation)"
            : input.amm === "uniswap-v3"
              ? "Uniswap V3 full-range (no range given → constant-product approximation; concentrated ranges need range_lower/range_upper)"
              : "Uniswap V2 constant-product 50/50";
    notes.push(`${model}: IL = p^w1/(w0+w1·p) − 1 with p = P_end/P_start.`);
  }

  if (input.deposit_amounts) {
    notes.push(
      `deposit_amounts [${input.deposit_amounts[0]}, ${input.deposit_amounts[1]}] recorded for reference; ` +
        `IL is a relative measure and does not depend on deposit size (fees scale linearly with it).`
    );
  }

  let fee_apr_est: number | null = null;
  let volume_window: number | null = null;
  if (
    input.volume_window_usd !== undefined &&
    input.fee_tier_bps !== undefined &&
    input.tvl_usd !== undefined
  ) {
    fee_apr_est = feeApr(input.volume_window_usd, input.fee_tier_bps, input.tvl_usd, input.window_hours);
    volume_window = input.volume_window_usd;
    notes.push(
      `fee_apr_est assumes uniform volume over the window and no change in TVL/fee tier: ` +
        `(${input.volume_window_usd} × ${input.fee_tier_bps / 100}% / ${input.tvl_usd}) × (8760/${input.window_hours}h).`
    );
  } else {
    notes.push(
      "fee_apr_est is null: provide volume_window_usd + fee_tier_bps + tvl_usd for a fee APR estimate. " +
        "The agent never invents volume or TVL figures."
    );
  }

  notes.push(
    "Assumptions: no deposits/withdrawals during the window; price ratio uses pool spot prices at window ends; " +
      "MEV, rebalancing costs and gas are excluded."
  );

  return {
    IL_percent: il * 100,
    fee_apr_est,
    volume_window,
    notes,
    inputs_echo: {
      pool_address: input.pool_address,
      amm: input.amm!,
      price_ratio: priceRatio,
      token_weights: [w0, w1],
      window_hours: input.window_hours,
    },
  };
}
