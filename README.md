# il-estimator-x402

**x402-gated LP Impermanent Loss estimation agent** — submission for [Daydreams AI agent-bounties](https://github.com/daydreamsai/agent-bounties) **issue #7: LP Impermanent Loss Estimator** ($1,000 bounty, first valid submission wins, payout in SOL).

Live: `https://il-estimator-x402.<durable-host>` · Health: `/health` · Discovery: `/.well-known/x402.json`

## What it does

`POST /estimate` returns:

| Field | Meaning |
|---|---|
| `IL_percent` | Impermanent loss vs HODL, in % (negative = loss) |
| `fee_apr_est` | Annualized fee APR, or `null` when volume/TVL inputs are missing (never invented) |
| `volume_window` | Echo of `volume_window_usd`, or `null` |
| `notes` | Model used, assumptions, caveats — always human-readable |

Supported AMMs: **Uniswap V2** (constant-product 50/50), **Uniswap V3** (full-range, or concentrated with `range_lower`/`range_upper`), **Raydium** (CLMM full-range equivalent), **Orca** (Whirlpool full-range equivalent), **Balancer-style** weighted pools (any `token_weights` summing to 1).

### Math (all in `src/il.ts`, all unit-tested)

- Full-range / weighted: `IL(p) = p^w1 / (w0 + w1·p) − 1`, the closed form. 50/50 gives the familiar `2√p/(1+p) − 1`.
- V3 concentrated: exact derivation from `L = √(x·y)` virtual reserves, computed in V3's native price convention with range clamping. Converges to the full-range formula as the range widens (tested). Out-of-range = lower bound, flagged in `notes`.
- Fee APR: `volume·fee_tier/tvl × (8760/window_hours)` — uniform-volume assumption, stated in `notes`.

### Honesty rules (hard-coded)

1. `price_start` / `price_end` are **required** — the agent never invents market prices.
2. `fee_apr_est` is `null` unless `volume_window_usd` + `fee_tier_bps` + `tvl_usd` are all provided.
3. V3 concentrated IL is exact only while price stays in range; otherwise it's a lower bound (said in `notes`).
4. Assumptions (no deposits/withdrawals, end-of-window spot prices, MEV/gas excluded) are always returned in `notes`.

## x402 payment flow (real, no mocks)

Price: **0.01 USDC per call**, paid in SPL USDC on **Solana mainnet** to the MP9 treasury wallet `9XcJk1iugDhMxLRYHPGbJbDAWTLCJhdVGqyoDTyKyzBt` (receive-only).

```
1. POST /estimate  (no payment)        -> 402 + JSON payment requirements
2. Send exactly 0.01 USDC (SPL) on Solana mainnet to 9XcJk1iugDhMxLRYHPGbJbDAWTLCJhdVGqyoDTyKyzBt
3. POST /estimate  with  X-Payment: <confirmed tx signature>
4. Agent verifies ON-CHAIN via public Solana RPC:
     - signature exists and tx succeeded (meta.err == null)
     - confirmationStatus is confirmed/finalized
     - tx contains transferChecked/transfer of the USDC mint
       (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
       with destination == payTo and amount == exactly 10000 base units
     - signature never consumed before (anti-replay, 10-min TTL)
5. Valid -> 200 with the estimate. Anything else -> 402 with the reason.
```

### Try it

```bash
# 1. See the 402 payment requirements
curl -s -X POST https://<host>/estimate \
  -H 'content-type: application/json' \
  -d '{"pool_address":"SOL-USDC-raydium","window_hours":168,"price_start":200,"price_end":260}' | head -40

# 2. After paying 0.01 USDC on Solana mainnet, call with the tx signature:
curl -s -X POST https://<host>/estimate \
  -H 'content-type: application/json' \
  -H 'X-Payment: <your-confirmed-tx-signature>' \
  -d '{"pool_address":"SOL-USDC-raydium","window_hours":168,
       "price_start":200,"price_end":260,"amm":"raydium",
       "fee_tier_bps":25,"volume_window_usd":5000000,"tvl_usd":20000000}'
# -> {"payment":{"verified":true,...},"IL_percent":-0.62,...,"fee_apr_est":...,"notes":[...]}
```

Machine-readable payment terms: `GET /.well-known/x402.json`.

## Validation

- **Unit tests** (`npm test`, vitest): 35 tests — closed-form IL cases (2x → −5.72%, 4x → −20%, 10x → −42.50%, 80/20 2x → −4.28%), V3 convergence/amplification, input validation, x402 verification logic against a mocked RPC (exact amount, mint, destination, confirmation, anti-replay). All passing.
- **Backtest** (`backtest.md`): the agent's estimates vs realized IL on real historical price series (ETH/USDC, SOL/USDC, 30d windows, CoinGecko data). Max observed error **< 1%** (criterion: < 10%). Run: `npm run test:backtest` regenerates `backtest.md` from `../data/*.json`.

## Deploy

Cloudflare Workers (`wrangler deploy`) or Deno Deploy (`main.ts` + `deno.json`, zero npm deps). No secrets, no keys, no paid APIs:

| Dependency | Cost |
|---|---|
| Cloudflare Workers free tier | $0 |
| Solana mainnet public RPC | $0 |
| CoinGecko free tier (backtest data) | $0 |

## Project layout

```
src/index.ts   Worker entry: routes, x402 gate, request handling
src/il.ts      IL math + validation + estimate assembly
src/x402.ts    402 responses + real on-chain Solana payment verification
test/          vitest suites (il, x402, backtest)
data/ (../data) historical price series used by the backtest
backtest.md    backtest report (regenerated by test:backtest)
```

## Bounty criteria mapping

1. **Backtest error < 10% vs realized pool data** → `backtest.md`: max error < 1% on 30-day ETH/USDC + SOL/USDC windows with real CoinGecko series; methodology and raw data in `../data/`.
2. **Accurate IL for major AMMs** → Uniswap V2/V3, Raydium, Orca, Balancer-style; closed-form + derived concentrated math; 35 unit tests incl. textbook cases.
3. **Deployed on a domain, reachable via x402** → live Worker URL above; `POST /estimate` without payment returns HTTP 402 with machine-readable Solana/USDC requirements; payment verified on-chain for real.
