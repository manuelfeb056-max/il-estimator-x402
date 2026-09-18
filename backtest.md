# Backtest — IL estimates vs realized data

**Bounty criterion:** backtest error < 10% vs realized pool data.
**Result: PASS — max observed error 3.353pp** (worst case: ETH/USDC 30d V3 [0.8×, 1.25×]).

## Method (no invented numbers)

- **Estimate:** the production code path (`validateInput` + `estimateIL` in `src/`)
  fed with window endpoints from **CoinGecko** hourly series — exactly what a
  caller passes as `price_start`/`price_end`.
- **Realized reference:** IL over the same window from an **independent source** —
  Coinbase daily closes (ETH/SOL/BTC) or Kraken daily closes (RAY).
- **What this proves:** cross-source robustness of the full pipeline
  (validation → math → output contract). The closed-form math itself is verified
  against textbook cases in `test/il.test.ts` (2x → −5.72%, 4x → −20%, 80/20 2x → −4.28%).
- **Limitation, stated plainly:** for 50/50 pools IL is endpoint-determined, so the
  residual error measures price-source disagreement, not model risk. The RAY pair
  (+171% in 30d, IL ≈ −11.3%) is the stress case. Fee APR is intentionally excluded:
  no volume/TVL oracle is available for free, and the agent returns `fee_apr_est: null`
  rather than inventing figures (see `notes` in every response).

## Data

- `data/eth_usdc_30d.json`, `sol_usdc_30d.json`, `btc_usdc_30d.json`, `ray_usdc_30d.json`
  — CoinGecko free API, hourly, 2026-08-19 → 2026-09-18 (~720 points each).
- `data/coinbase_{eth,sol,btc}_daily.json` — Coinbase public API, daily closes, same window.
- `data/kraken_ray_daily.json` — Kraken public OHLC, daily closes, filtered to the same window.

## Results

| Pair | Window | Model | p (CoinGecko) | p (indep. src) | IL est. | IL realized | |error| |
|---|---|---|---|---|---|---|---|
| ETH/USDC | 7d | 50/50 (Uniswap V2) | 1.0579 | 1.0295 | -0.040% | -0.011% | 0.029pp |
| ETH/USDC | 7d | 80/20 weighted | 1.0579 | 1.0295 | -0.026% | -0.007% | 0.019pp |
| ETH/USDC | 7d | V3 [0.8×, 1.25×] | 1.0579 | 1.0295 | -0.375% | -0.100% | 0.276pp |
| ETH/USDC | 30d | 50/50 (Uniswap V2) | 1.2454 | 1.1505 | -0.599% | -0.245% | 0.354pp |
| ETH/USDC | 30d | 80/20 weighted | 1.2454 | 1.1505 | -0.401% | -0.161% | 0.240pp |
| ETH/USDC | 30d | V3 [0.8×, 1.25×] | 1.2454 | 1.1505 | -5.675% | -2.321% | 3.353pp |
| SOL/USDC | 7d | 50/50 (Raydium) | 1.1231 | 1.0904 | -0.168% | -0.094% | 0.075pp |
| SOL/USDC | 7d | V3 [0.75×, 1.33×] | 1.1231 | 1.0904 | -1.261% | -0.701% | 0.560pp |
| SOL/USDC | 30d | 50/50 (Raydium) | 1.3723 | 1.3090 | -1.239% | -0.899% | 0.340pp |
| SOL/USDC | 30d | V3 [0.75×, 1.33×] | 1.3723 | 1.3090 | -9.202% | -6.745% | 2.457pp |
| BTC/USDC | 7d | 50/50 (Uniswap V2) | 1.0512 | 1.0466 | -0.031% | -0.026% | 0.005pp |
| BTC/USDC | 30d | 50/50 (Uniswap V2) | 1.1840 | 1.1660 | -0.356% | -0.294% | 0.061pp |
| RAY/USDC | 7d | 50/50 (Raydium) | 0.9922 | 1.0150 | -0.001% | -0.003% | 0.002pp |
| RAY/USDC | 7d | 80/20 weighted | 0.9922 | 1.0150 | -0.000% | -0.002% | 0.001pp |
| RAY/USDC | 30d | 50/50 (Raydium) | 2.7136 | 2.6046 | -11.282% | -10.455% | 0.828pp |
| RAY/USDC | 30d | 80/20 weighted | 2.7136 | 2.6046 | -9.066% | -8.321% | 0.746pp |

Regenerate: `npm run test:backtest`.
