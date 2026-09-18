/**
 * il-estimator-x402 — Cloudflare Worker.
 *
 * x402-gated LP Impermanent Loss estimation agent (Daydreams AI bounty #7).
 * Pays 0.01 USDC on Solana mainnet per call; payment verified on-chain (real, no mocks).
 */

import { validateInput, estimateIL, InputError } from "./il";
import {
  verifySolanaPayment,
  markSignatureUsed,
  paymentRequiredResponse,
  paymentRequirements,
  PAY_TO,
  PRICE_DISPLAY,
  X402_VERSION,
} from "./x402";

interface Env {
  SOLANA_RPC_URL?: string;
}

const VERSION = "1.0.0";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

const DOCS = {
  name: "il-estimator-x402",
  version: VERSION,
  description:
    "x402-gated agent that estimates impermanent loss (IL) and fee APR for LP positions on major AMMs " +
    "(Uniswap V2/V3, Raydium, Orca, Balancer-style weighted pools). Daydreams AI bounty #7 submission.",
  pricing: `${PRICE_DISPLAY} per call, paid in USDC on Solana mainnet to ${PAY_TO}`,
  endpoints: {
    "GET /": "this documentation",
    "GET /health": "liveness probe",
    "GET /.well-known/x402.json": "x402 payment discovery document",
    "POST /estimate": "IL + fee APR estimate (requires X-Payment; without it returns HTTP 402)",
  },
  estimate_input: {
    pool_address: "string (required) — on-chain pool address, echoed for reference",
    token_weights: "[w0, w1] (optional, default [0.5, 0.5]) — must sum to 1",
    deposit_amounts: "[a0, a1] (optional) — recorded for reference only",
    window_hours: "number (required) — analysis window in hours",
    price_start: "number (required) — pool price of token1 in token0 at window start",
    price_end: "number (required) — pool price of token1 in token0 at window end",
    amm: "uniswap-v2 | uniswap-v3 | raydium | orca | balancer (default uniswap-v2)",
    fee_tier_bps: "number (optional) — e.g. 30 for 0.30%",
    volume_window_usd: "number (optional)",
    tvl_usd: "number (optional)",
    range_lower: "number (optional, uniswap-v3) — lower bound as multiple of price_start",
    range_upper: "number (optional, uniswap-v3) — upper bound as multiple of price_start",
  },
  estimate_output: {
    IL_percent: "number — impermanent loss vs HODL, in percent (negative = loss)",
    fee_apr_est: "number | null — annualized fee APR, or null when volume/tvl not provided",
    volume_window: "number | null — echo of volume_window_usd",
    notes: "string[] — model used, assumptions and caveats",
  },
  payment_flow: [
    "1. POST /estimate without payment -> HTTP 402 with payment requirements.",
    `2. Send exactly ${PRICE_DISPLAY} (SPL USDC) on Solana mainnet to ${PAY_TO}.`,
    "3. Retry the identical POST with header `X-Payment: <confirmed tx signature>`.",
    "4. The agent verifies the transaction on-chain via public Solana RPC (exact amount, USDC mint, destination, confirmed status) and rejects replays.",
    "5. On success -> HTTP 200 with the estimate.",
  ],
  honesty: [
    "The agent never invents market prices: price_start/price_end are required inputs.",
    "fee_apr_est is null unless volume_window_usd + fee_tier_bps + tvl_usd are all provided.",
    "V3 concentrated IL is exact only while price stays in range; otherwise it is a lower bound (stated in notes).",
  ],
};

function discovery(host: string) {
  return {
    x402Version: X402_VERSION,
    service: "il-estimator-x402",
    version: VERSION,
    ...{ accepts: paymentRequirements(host).accepts },
    endpoints: [
      { path: "/estimate", method: "POST", ...{ accepts: paymentRequirements(host).accepts[0] } },
    ],
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const host = url.host;

    if (req.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-payment",
        },
      });

    if (url.pathname === "/" && req.method === "GET") return json(DOCS);
    if (url.pathname === "/health" && req.method === "GET")
      return json({ ok: true, version: VERSION, time: new Date().toISOString(), x402: { network: "solana", payTo: PAY_TO, price: PRICE_DISPLAY } });
    if (url.pathname === "/.well-known/x402.json" && req.method === "GET") return json(discovery(host));

    if (url.pathname === "/estimate" && req.method === "POST") {
      const rpcUrl = env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
      const paymentSig = req.headers.get("x-payment");

      if (!paymentSig) return paymentRequiredResponse(host);

      const check = await verifySolanaPayment(paymentSig.trim(), rpcUrl).catch((e: Error) => ({
        ok: false as const,
        reason: `verification error: ${e.message}`,
      }));
      if (!check.ok) return paymentRequiredResponse(host, check.reason);
      markSignatureUsed(paymentSig.trim());

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }

      let input;
      try {
        input = validateInput(body);
      } catch (e) {
        return json({ error: (e as InputError).message }, 422);
      }
      if (input.price_start === undefined || input.price_end === undefined) {
        return json(
          {
            error:
              "price_start and price_end are required. This agent does not invent market prices — " +
              "pass the pool spot price (token1 in token0) at the window start and end.",
          },
          422
        );
      }

      const priceRatio = input.price_end / input.price_start;
      const out = estimateIL(input, priceRatio);
      return json({ payment: { verified: true, network: "solana", amount: PRICE_DISPLAY }, ...out });
    }

    return json({ error: "not found" }, 404);
  },
};
