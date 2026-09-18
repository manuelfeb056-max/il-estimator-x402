/**
 * Real x402 payment rail on Solana (no mocks).
 *
 * Flow:
 *   1. Client POSTs /estimate with NO payment  -> 402 + payment requirements.
 *   2. Client sends 0.01 USDC on Solana mainnet to PAY_TO (any wallet / dApp).
 *   3. Client retries POST /estimate with header `X-Payment: <tx signature>`.
 *   4. Server verifies on-chain via public Solana RPC:
 *        - tx exists, succeeded (meta.err == null), confirmed/finalized
 *        - contains an SPL Token transferChecked/transfer of the USDC mint
 *          with destination == PAY_TO and amount == PRICE (10000 base units)
 *        - signature never used before (in-memory anti-replay with TTL)
 *   5. If valid -> the estimate is computed and returned (200).
 */

export const X402_VERSION = 1;
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC, 6 decimals
export const PAY_TO = "9XcJk1iugDhMxLRYHPGbJbDAWTLCJhdVGqyoDTyKyzBt"; // MP9 treasury (receive-only)
export const PRICE_BASE_UNITS = "10000"; // 0.01 USDC
export const PRICE_DISPLAY = "0.01 USDC";
export const PAYMENT_TTL_MS = 10 * 60 * 1000; // a signature can be consumed once, within 10 min

interface UsedSig { usedAt: number; }

/** Anti-replay store: signature -> use time. Pruned on access. */
const used = new Map<string, UsedSig>();

function pruneUsed(now: number) {
  for (const [sig, v] of used) if (now - v.usedAt > PAYMENT_TTL_MS) used.delete(sig);
}

export function isSignatureUsed(sig: string): boolean {
  pruneUsed(Date.now());
  return used.has(sig);
}

export function markSignatureUsed(sig: string): void {
  pruneUsed(Date.now());
  used.set(sig, { usedAt: Date.now() });
}

export function paymentRequirements(host: string) {
  return {
    x402Version: X402_VERSION,
    error: "Payment required",
    accepts: [
      {
        scheme: "exact",
        network: "solana",
        asset: USDC_MINT,
        payTo: PAY_TO,
        amount: PRICE_BASE_UNITS,
        amountDisplay: PRICE_DISPLAY,
        maxTimeoutSeconds: 600,
        resource: `https://${host}/estimate`,
        description: "LP Impermanent Loss estimate (one call)",
        mimeType: "application/json",
        extra: {
          howToPay:
            `Send exactly ${PRICE_DISPLAY} (SPL USDC) on Solana mainnet to ${PAY_TO}, ` +
            "then retry the same request with header `X-Payment: <confirmed transaction signature>`.",
          verifyEndpoint: `https://${host}/estimate`,
        },
      },
    ],
  };
}

export function paymentRequiredResponse(host: string, reason?: string): Response {
  const body = paymentRequirements(host) as Record<string, unknown>;
  if (reason) body.paymentError = reason;
  return new Response(JSON.stringify(body, null, 2), {
    status: 402,
    headers: { "content-type": "application/json", "x-402-version": String(X402_VERSION) },
  });
}

interface RpcResult { ok: boolean; reason?: string; }

/**
 * Verify a Solana tx signature is a qualifying USDC payment.
 * `fetcher` defaults to global fetch (injectable for tests).
 */
export async function verifySolanaPayment(
  signature: string,
  rpcUrl: string,
  fetcher: typeof fetch = fetch
): Promise<RpcResult> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(signature))
    return { ok: false, reason: "X-Payment must be a base58 Solana transaction signature" };
  if (isSignatureUsed(signature))
    return { ok: false, reason: "payment signature already consumed (anti-replay)" };

  const rpc = async (method: string, params: unknown[]) => {
    const r = await fetcher(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}`);
    const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
    if (j.error) throw new Error(`RPC ${method}: ${j.error.message ?? "unknown error"}`);
    return j.result;
  };

  // 1. confirmed/finalized status
  let statuses: Array<{ confirmationStatus?: string; err?: unknown } | null>;
  try {
    statuses = (await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])) as typeof statuses;
  } catch (e) {
    return { ok: false, reason: `RPC error: ${(e as Error).message}` };
  }
  const st = statuses?.[0];
  if (!st) return { ok: false, reason: "signature not found on Solana mainnet (yet?)" };
  if (st.err) return { ok: false, reason: "transaction failed on-chain" };
  if (st.confirmationStatus !== "confirmed" && st.confirmationStatus !== "finalized")
    return { ok: false, reason: `transaction not confirmed (status=${st.confirmationStatus ?? "unknown"})` };

  // 2. parsed transaction: must move exactly PRICE_BASE_UNITS of USDC mint to PAY_TO
  let tx: {
    meta?: { err?: unknown };
    transaction?: { message?: { instructions?: Array<{ parsed?: { type?: string; info?: Record<string, unknown> }; program?: string }> } };
  } | null;
  try {
    tx = (await rpc("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }])) as typeof tx;
  } catch (e) {
    return { ok: false, reason: `RPC error: ${(e as Error).message}` };
  }
  if (!tx?.meta) return { ok: false, reason: "transaction not retrievable" };
  if (tx.meta.err) return { ok: false, reason: "transaction failed on-chain" };

  const ixs = tx.transaction?.message?.instructions ?? [];
  const match = ixs.some((ix) => {
    const p = ix.parsed;
    if (!p || (p.type !== "transferChecked" && p.type !== "transfer")) return false;
    const info = (p.info ?? {}) as Record<string, unknown>;
    const amount = String((info.tokenAmount as Record<string, unknown> | undefined)?.amount ?? info.amount ?? "");
    return info.mint === USDC_MINT && info.destination === PAY_TO && amount === PRICE_BASE_UNITS;
  });

  if (!match)
    return {
      ok: false,
      reason: `no transfer of exactly ${PRICE_DISPLAY} (USDC ${USDC_MINT}) to ${PAY_TO} found in this transaction`,
    };

  return { ok: true };
}
