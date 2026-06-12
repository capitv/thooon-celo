/**
 * @jest-environment node
 *
 * Covers POST /api/celo/check-in/verify.
 *
 * Casos:
 *   - challenge ausente/expirado → 400
 *   - challenge de outro usuário → 403
 *   - tx pendente → 202 (nonce NÃO consumido)
 *   - tx revertida → 400 (nonce NÃO consumido)
 *   - RPC fora → 503 (nonce NÃO consumido)
 *   - nonce do evento ≠ challenge → 403 (anti-spoof)
 *   - account do evento ≠ wallet do challenge → 403
 *   - sucesso → 200, record_celo_checkin chamado, nonce consumido
 *   - wallet_conflict → 409
 *   - already_claimed / tx_already_used → 409
 */

const USER_ID = "user-id";
const WALLET = "0x00000000000000000000000000000000000000aa";
const NONCE = `0x${"a".repeat(64)}`;
const TX_HASH = `0x${"b".repeat(64)}`;

const state: {
  challenge: Record<string, unknown> | null;
  verification: Record<string, unknown>;
  verificationThrows: boolean;
  rpcResult: Record<string, unknown> | null;
  yesterdayCheckIn: { streak_day: number } | null;
} = {
  challenge: null,
  verification: { status: "confirmed" },
  verificationThrows: false,
  rpcResult: { success: true, streak_day: 1, gold_awarded: 10 },
  yesterdayCheckIn: null,
};

const mockDeleteCache = jest.fn(async () => true);

jest.mock("@/lib/rateLimit", () => ({
  withRateLimit: jest.fn().mockResolvedValue({ allowed: true, response: undefined }),
  RATE_LIMITS: { CELO_VERIFY: { interval: 60, limit: 20 }, READ: { interval: 60, limit: 100 }, CRITICAL: { interval: 60, limit: 10 } },
}));

jest.mock("@/app/api/celo/_helpers", () => ({
  celoCheckInGate: jest.fn(() => null),
}));

jest.mock("@/lib/cache/playerCaches", () => ({
  invalidatePlayerReadCaches: jest.fn(async () => undefined),
}));

jest.mock("@/lib/supabase", () => ({
  isSupabaseAdminConfigured: jest.fn(() => true),
  getAuthenticatedUser: jest.fn(async () => ({
    user: { id: "user-id", email: "test@example.com" },
    error: null,
  })),
}));

const mockRpc = jest.fn(async () => ({ data: state.rpcResult, error: null }));

jest.mock("@/lib/supabase/server", () => ({
  supabaseAdmin: {
    from: jest.fn(() => {
      const chain: any = {
        select: jest.fn(() => chain),
        eq: jest.fn(() => chain),
        limit: jest.fn(() => chain),
        maybeSingle: jest.fn(async () => ({
          data: state.yesterdayCheckIn,
          error: null,
        })),
      };
      return chain;
    }),
    rpc: (...args: unknown[]) => mockRpc(...(args as [])),
  },
}));

jest.mock("@/lib/redisCache", () => ({
  getCache: jest.fn(async () => state.challenge),
  deleteCache: (...args: unknown[]) => mockDeleteCache(...(args as [])),
}));

jest.mock("@/lib/celo/checkin", () => ({
  getCeloCheckInNonceKey: (n: string) => `celo-checkin:nonce:${n}`,
  verifyCheckInTx: jest.fn(async () => {
    if (state.verificationThrows) throw new Error("rpc down");
    return state.verification;
  }),
}));

import { POST } from "../verify/route";

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/celo/check-in/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as any;
}

function validChallenge() {
  return {
    nonce: NONCE,
    userId: USER_ID,
    walletAddress: WALLET,
    issuedAt: new Date().toISOString(),
  };
}

function confirmedVerification(overrides: Record<string, unknown> = {}) {
  return {
    status: "confirmed",
    account: WALLET,
    nonce: NONCE,
    day: 20600,
    streak: 1,
    blockNumber: 100n,
    ...overrides,
  };
}

describe("POST /api/celo/check-in/verify", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state.challenge = validChallenge();
    state.verification = confirmedVerification();
    state.verificationThrows = false;
    state.rpcResult = { success: true, streak_day: 1, gold_awarded: 10 };
    state.yesterdayCheckIn = null;
  });

  it("400 quando o challenge expirou", async () => {
    state.challenge = null;
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(400);
    expect(mockDeleteCache).not.toHaveBeenCalled();
  });

  it("403 quando o challenge pertence a outro usuário", async () => {
    state.challenge = { ...validChallenge(), userId: "other-user" };
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(403);
  });

  it("202 com tx pendente — nonce não consumido", async () => {
    state.verification = { status: "pending" };
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.pending).toBe(true);
    expect(mockDeleteCache).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("400 com tx revertida — nonce não consumido", async () => {
    state.verification = { status: "failed" };
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(400);
    expect(mockDeleteCache).not.toHaveBeenCalled();
  });

  it("503 com RPC fora — nonce não consumido", async () => {
    state.verificationThrows = true;
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(503);
    expect(mockDeleteCache).not.toHaveBeenCalled();
  });

  it("403 quando o nonce do evento difere do challenge (anti-spoof)", async () => {
    state.verification = confirmedVerification({ nonce: `0x${"c".repeat(64)}` });
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("403 quando a account do evento difere da wallet do challenge", async () => {
    state.verification = confirmedVerification({
      account: "0x00000000000000000000000000000000000000bb",
    });
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(403);
  });

  it("200 no caminho feliz: RPC chamada, nonce consumido", async () => {
    state.rpcResult = { success: true, streak_day: 3, gold_awarded: 20 };
    state.yesterdayCheckIn = { streak_day: 2 };
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      success: true,
      walletLinked: WALLET,
      streak: 3,
      goldAwarded: 20,
    });
    expect(mockRpc).toHaveBeenCalledWith(
      "record_celo_checkin",
      expect.objectContaining({
        p_profile_id: USER_ID,
        p_wallet: WALLET,
        p_tx_hash: TX_HASH,
        p_nonce: NONCE,
        p_chain_day: 20600,
        p_gold: 20, // streak 3: 10 + 2×5
      })
    );
    expect(mockDeleteCache).toHaveBeenCalledWith(`celo-checkin:nonce:${NONCE}`);
  });

  it("409 em wallet_conflict", async () => {
    state.rpcResult = { success: false, error: "wallet_conflict" };
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(409);
    expect(mockDeleteCache).not.toHaveBeenCalled();
  });

  it("409 em already_claimed e tx_already_used", async () => {
    state.rpcResult = { success: false, error: "already_claimed" };
    let res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(409);

    state.rpcResult = { success: false, error: "tx_already_used" };
    res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(409);
  });

  it("400 com body inválido (txHash malformado)", async () => {
    const res = await POST(makeRequest({ txHash: "0x123", nonce: NONCE }));
    expect(res.status).toBe(400);
  });
});
