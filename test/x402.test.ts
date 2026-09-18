import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifySolanaPayment,
  markSignatureUsed,
  paymentRequirements,
  USDC_MINT,
  PAY_TO,
  PRICE_BASE_UNITS,
} from "../src/x402";

// NOTE: these are unit tests with a MOCKED RPC fetcher (no network).
// They verify the verification LOGIC (exact amount, mint, destination,
// confirmation status, anti-replay). Live on-chain verification happens
// at runtime against https://api.mainnet-beta.solana.com.

const SIG = "5".repeat(87); // syntactically valid base58 signature shape

function mockRpc(handlers: Record<string, unknown>) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const result = handlers[body.method];
    if (result instanceof Error) throw result;
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as Response;
  });
}

const goodTransferIx = {
  program: "spl-token",
  parsed: {
    type: "transferChecked",
    info: {
      mint: USDC_MINT,
      destination: PAY_TO,
      tokenAmount: { amount: PRICE_BASE_UNITS, decimals: 6 },
    },
  },
};

const goodTx = {
  meta: { err: null },
  transaction: { message: { instructions: [goodTransferIx] } },
};

beforeEach(() => {
  // anti-replay store is module-level; use fresh signatures per test
});

describe("paymentRequirements (402 body)", () => {
  it("advertises solana/USDC/PAY_TO/exact amount", () => {
    const r = paymentRequirements("example.workers.dev");
    expect(r.x402Version).toBe(1);
    const a = r.accepts[0];
    expect(a.network).toBe("solana");
    expect(a.asset).toBe(USDC_MINT);
    expect(a.payTo).toBe(PAY_TO);
    expect(a.amount).toBe(PRICE_BASE_UNITS);
    expect(a.scheme).toBe("exact");
  });
});

describe("verifySolanaPayment", () => {
  it("accepts a valid confirmed USDC payment", async () => {
    const fetch = mockRpc({
      getSignatureStatuses: [{ confirmationStatus: "finalized", err: null }],
      getTransaction: goodTx,
    });
    const r = await verifySolanaPayment("6".repeat(87), "https://rpc", fetch as unknown as typeof globalThis.fetch);
    expect(r.ok).toBe(true);
  });

  it("rejects wrong amount", async () => {
    const bad = JSON.parse(JSON.stringify(goodTx));
    bad.transaction.message.instructions[0].parsed.info.tokenAmount.amount = "9999";
    const fetch = mockRpc({
      getSignatureStatuses: [{ confirmationStatus: "confirmed", err: null }],
      getTransaction: bad,
    });
    const r = await verifySolanaPayment("7".repeat(87), "https://rpc", fetch as unknown as typeof globalThis.fetch);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("0.01 USDC");
  });

  it("rejects wrong destination", async () => {
    const bad = JSON.parse(JSON.stringify(goodTx));
    bad.transaction.message.instructions[0].parsed.info.destination = "11111111111111111111111111111111";
    const fetch = mockRpc({
      getSignatureStatuses: [{ confirmationStatus: "confirmed", err: null }],
      getTransaction: bad,
    });
    const r = await verifySolanaPayment("8".repeat(87), "https://rpc", fetch as unknown as typeof globalThis.fetch);
    expect(r.ok).toBe(false);
  });

  it("rejects unconfirmed transactions", async () => {
    const fetch = mockRpc({
      getSignatureStatuses: [{ confirmationStatus: "processed", err: null }],
      getTransaction: goodTx,
    });
    const r = await verifySolanaPayment("9".repeat(87), "https://rpc", fetch as unknown as typeof globalThis.fetch);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not confirmed");
  });

  it("rejects failed transactions", async () => {
    const fetch = mockRpc({ getSignatureStatuses: [{ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }] });
    const r = await verifySolanaPayment("a".repeat(87).replaceAll("a", "2"), "https://rpc", fetch as unknown as typeof globalThis.fetch);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("failed");
  });

  it("rejects unknown signatures", async () => {
    const fetch = mockRpc({ getSignatureStatuses: [null] });
    const r = await verifySolanaPayment("3".repeat(87), "https://rpc", fetch as unknown as typeof globalThis.fetch);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not found");
  });

  it("rejects malformed signatures", async () => {
    const fetch = mockRpc({});
    const r = await verifySolanaPayment("not-a-signature", "https://rpc", fetch as unknown as typeof globalThis.fetch);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("base58");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enforces anti-replay: a signature cannot be verified twice", async () => {
    const fetch = mockRpc({
      getSignatureStatuses: [{ confirmationStatus: "finalized", err: null }],
      getTransaction: goodTx,
    });
    const sig = SIG;
    const first = await verifySolanaPayment(sig, "https://rpc", fetch as unknown as typeof globalThis.fetch);
    expect(first.ok).toBe(true);
    markSignatureUsed(sig); // what index.ts does after a successful payment
    const second = await verifySolanaPayment(sig, "https://rpc", fetch as unknown as typeof globalThis.fetch);
    expect(second.ok).toBe(false);
    expect(second.reason).toContain("already consumed");
  });
});
