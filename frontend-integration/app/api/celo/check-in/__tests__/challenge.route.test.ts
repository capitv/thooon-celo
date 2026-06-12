/**
 * @jest-environment node
 *
 * Covers POST /api/celo/check-in/challenge.
 *
 * Casos:
 *   - sucesso → 200 com nonce hex de 32 bytes, contractAddress, chainId 42220
 *   - wallet de outro perfil → 409
 *   - já fez check-in hoje → 429 (não emite challenge para revert garantido)
 *   - Redis indisponível → 503
 *   - body inválido → 400
 */

const WALLET = "0x00000000000000000000000000000000000000Aa";

const state: {
  conflict: { id: string } | null;
  todayCheckIn: { id: string } | null;
  cacheOk: boolean;
} = {
  conflict: null,
  todayCheckIn: null,
  cacheOk: true,
};

const mockSetCache = jest.fn(async () => state.cacheOk);

jest.mock("@/lib/rateLimit", () => ({
  withRateLimit: jest.fn().mockResolvedValue({ allowed: true, response: undefined }),
  RATE_LIMITS: { CRITICAL: { interval: 60, limit: 10 } },
}));

jest.mock("@/app/api/celo/_helpers", () => ({
  celoCheckInGate: jest.fn(() => null),
}));

jest.mock("@/lib/supabase", () => ({
  isSupabaseAdminConfigured: jest.fn(() => true),
  getAuthenticatedUser: jest.fn(async () => ({
    user: { id: "user-id", email: "test@example.com" },
    error: null,
  })),
}));

jest.mock("@/lib/supabase/server", () => ({
  supabaseAdmin: {
    from: jest.fn((table: string) => {
      const chain: any = {
        select: jest.fn(() => chain),
        ilike: jest.fn(() => chain),
        neq: jest.fn(() => chain),
        eq: jest.fn(() => chain),
        limit: jest.fn(() => chain),
        maybeSingle: jest.fn(async () => ({
          data: table === "profiles" ? state.conflict : state.todayCheckIn,
          error: null,
        })),
      };
      return chain;
    }),
  },
}));

jest.mock("@/lib/redisCache", () => ({
  setCache: (...args: unknown[]) => mockSetCache(...(args as [])),
}));

jest.mock("@/lib/celo/checkin", () => ({
  CELO_CHECKIN_NONCE_TTL_SECONDS: 1800,
  getCeloCheckInNonceKey: (n: string) => `celo-checkin:nonce:${n}`,
  getCheckInContractAddress: jest.fn(
    () => "0x1111111111111111111111111111111111111111"
  ),
}));

import { POST } from "../challenge/route";

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/celo/check-in/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as any;
}

describe("POST /api/celo/check-in/challenge", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state.conflict = null;
    state.todayCheckIn = null;
    state.cacheOk = true;
  });

  it("200 emite nonce válido e dados do contrato", async () => {
    const res = await POST(makeRequest({ walletAddress: WALLET }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(json.contractAddress).toBe(
      "0x1111111111111111111111111111111111111111"
    );
    expect(json.chainId).toBe(42220);
    expect(json.expiresInSeconds).toBe(1800);
    // Challenge persistido com wallet normalizada e TTL correto
    expect(mockSetCache).toHaveBeenCalledWith(
      expect.stringMatching(/^celo-checkin:nonce:0x[0-9a-f]{64}$/),
      expect.objectContaining({
        userId: "user-id",
        walletAddress: WALLET.toLowerCase(),
      }),
      1800
    );
  });

  it("409 quando a wallet pertence a outro perfil", async () => {
    state.conflict = { id: "other-profile" };
    const res = await POST(makeRequest({ walletAddress: WALLET }));
    expect(res.status).toBe(409);
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it("429 quando já fez check-in hoje", async () => {
    state.todayCheckIn = { id: "row" };
    const res = await POST(makeRequest({ walletAddress: WALLET }));
    expect(res.status).toBe(429);
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it("503 quando o Redis não persiste o challenge", async () => {
    state.cacheOk = false;
    const res = await POST(makeRequest({ walletAddress: WALLET }));
    expect(res.status).toBe(503);
  });

  it("400 com walletAddress inválido", async () => {
    const res = await POST(makeRequest({ walletAddress: "not-an-address" }));
    expect(res.status).toBe(400);
  });
});
