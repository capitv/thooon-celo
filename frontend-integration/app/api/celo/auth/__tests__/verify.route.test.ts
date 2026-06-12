/**
 * @jest-environment node
 *
 * Covers POST /api/celo/auth/verify — "Sign in with MiniPay".
 *
 * Casos:
 *   - challenge ausente → 400
 *   - tx pendente → 202 (nonce intacto)
 *   - método checkIn: nonce/account do evento não bate → 403
 *   - login de conta EXISTENTE (wallet já vinculada) → 200 com tokenHash,
 *     sem criar usuário
 *   - login NOVO via checkIn → cria usuário + record_celo_checkin + tokenHash
 *   - método selfProof: verificação ok → linka wallet + tokenHash
 *   - método signature: assinatura válida → linka wallet + tokenHash;
 *     inválida → 403; txHash no lugar de signature → 400
 *   - wallet_conflict na RPC → 409
 *   - cap horário de signup excedido → 429 (só pra contas novas)
 */

const WALLET = "0x00000000000000000000000000000000000000aa";
const NONCE = `0x${"a".repeat(64)}`;
const TX_HASH = `0x${"b".repeat(64)}`;
const SIGNATURE = `0x${"c".repeat(130)}`;
const USER_ID = "user-123";
// Email sintético de conta wallet-nativa (mesmo formato de celoWalletEmail).
const WALLET_EMAIL = `celo-${WALLET.replace(/^0x/, "")}@wallet.thooon.com`;

const state: {
  challenge: Record<string, unknown> | null;
  checkInVerification: Record<string, unknown>;
  selfProofVerification: Record<string, unknown>;
  signatureValid: boolean;
  lockAcquired: boolean;
  existingProfile: { id: string; email: string } | null;
  existingUserEmail: string;
  rpcResult: Record<string, unknown> | null;
  createUserError: { message: string } | null;
  signupCount: number;
  updateError: { code?: string; message: string } | null;
} = {
  challenge: null,
  checkInVerification: {},
  selfProofVerification: {},
  signatureValid: true,
  lockAcquired: true,
  existingProfile: null,
  existingUserEmail: "",
  rpcResult: { success: true, streak_day: 1, gold_awarded: 10 },
  createUserError: null,
  signupCount: 1,
  updateError: null,
};

const mockDeleteCache = jest.fn(async () => true);
const mockCreateUser = jest.fn(async () => ({
  data: state.createUserError ? null : { user: { id: USER_ID } },
  error: state.createUserError,
}));
const mockGenerateLink = jest.fn(async () => ({
  data: { properties: { hashed_token: "tok_hash_123" } },
  error: null,
}));
const mockGetUserById = jest.fn(async () => ({
  data: { user: { id: USER_ID, email: state.existingUserEmail } },
  error: null,
}));
const mockRpc = jest.fn(async () => ({ data: state.rpcResult, error: null }));
const mockUpdate = jest.fn(() => ({
  eq: jest.fn(async () => ({ error: state.updateError })),
}));

jest.mock("@/lib/rateLimit", () => ({
  withRateLimit: jest.fn().mockResolvedValue({ allowed: true, response: undefined }),
  RATE_LIMITS: { CELO_VERIFY: { interval: 60, limit: 20 }, CRITICAL: { interval: 60, limit: 10 } },
  getRateLimitIdentifier: jest.fn(() => "ip:127.0.0.1"),
}));

jest.mock("@/app/api/celo/_helpers", () => ({
  celoCheckInGate: jest.fn(() => null),
}));

jest.mock("@/lib/cache/playerCaches", () => ({
  invalidatePlayerReadCaches: jest.fn(async () => undefined),
}));

jest.mock("@/lib/supabase", () => ({
  isSupabaseAdminConfigured: jest.fn(() => true),
}));

jest.mock("@/lib/supabase/server", () => ({
  supabaseAdmin: {
    from: jest.fn((table: string) => {
      const chain: any = {
        select: jest.fn(() => chain),
        ilike: jest.fn(() => chain),
        eq: jest.fn(() => chain),
        limit: jest.fn(() => chain),
        maybeSingle: jest.fn(async () => ({
          data: table === "profiles" ? state.existingProfile : null,
          error: null,
        })),
        update: mockUpdate,
      };
      return chain;
    }),
    rpc: (...args: unknown[]) => mockRpc(...(args as [])),
    auth: {
      admin: {
        createUser: (...args: unknown[]) => mockCreateUser(...(args as [])),
        generateLink: (...args: unknown[]) => mockGenerateLink(...(args as [])),
        getUserById: (...args: unknown[]) => mockGetUserById(...(args as [])),
      },
    },
  },
}));

jest.mock("@/lib/redisCache", () => ({
  getCache: jest.fn(async () => state.challenge),
  deleteCache: (...args: unknown[]) => mockDeleteCache(...(args as [])),
  incrementCache: jest.fn(async () => state.signupCount),
  expireCache: jest.fn(async () => true),
  acquireLock: jest.fn(async () => state.lockAcquired),
  releaseLock: jest.fn(async () => undefined),
}));

jest.mock("@/lib/celo/checkin", () => ({
  verifyCheckInTx: jest.fn(async () => state.checkInVerification),
  calcCheckInReward: (s: number) => Math.min(10 + (s - 1) * 5, 50),
}));

jest.mock("@/lib/celo/auth", () => {
  const actual = jest.requireActual("@/lib/celo/auth");
  return {
    ...actual,
    verifySelfProofTx: jest.fn(async () => state.selfProofVerification),
    verifyLoginSignature: jest.fn(async () => state.signatureValid),
  };
});

import { POST } from "../verify/route";

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/celo/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as any;
}

function checkInChallenge() {
  return {
    nonce: NONCE,
    walletAddress: WALLET,
    method: "checkIn",
    issuedAt: new Date().toISOString(),
  };
}

function confirmedCheckIn(overrides: Record<string, unknown> = {}) {
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

describe("POST /api/celo/auth/verify", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state.challenge = checkInChallenge();
    state.checkInVerification = confirmedCheckIn();
    state.selfProofVerification = { status: "confirmed", account: WALLET };
    state.signatureValid = true;
    state.lockAcquired = true;
    state.existingProfile = null;
    state.existingUserEmail = WALLET_EMAIL;
    state.rpcResult = { success: true, streak_day: 1, gold_awarded: 10 };
    state.createUserError = null;
    state.signupCount = 1;
    state.updateError = null;
  });

  it("400 sem challenge", async () => {
    state.challenge = null;
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(400);
  });

  it("202 com tx pendente — nada consumido", async () => {
    state.checkInVerification = { status: "pending" };
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(202);
    expect(mockDeleteCache).not.toHaveBeenCalled();
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it("403 quando o evento não bate com o challenge", async () => {
    state.checkInVerification = confirmedCheckIn({
      account: "0x00000000000000000000000000000000000000bb",
    });
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(403);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it("200 login de conta wallet-nativa existente: sem createUser", async () => {
    state.existingProfile = { id: USER_ID, email: WALLET_EMAIL };
    state.existingUserEmail = WALLET_EMAIL;
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tokenHash).toBe("tok_hash_123");
    expect(json.isNewUser).toBe(false);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockGenerateLink).toHaveBeenCalledWith({
      type: "magiclink",
      email: WALLET_EMAIL,
    });
    expect(mockDeleteCache).toHaveBeenCalled();
  });

  it("403 quando a wallet está vinculada a conta de email REAL (anti bypass de captcha)", async () => {
    state.existingProfile = { id: USER_ID, email: "real@user.com" };
    state.existingUserEmail = "real@user.com";
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(403);
    expect(mockGenerateLink).not.toHaveBeenCalled();
    expect(mockDeleteCache).not.toHaveBeenCalled();
  });

  it("200 conta nova via checkIn: createUser + record_celo_checkin + gold", async () => {
    state.rpcResult = { success: true, streak_day: 1, gold_awarded: 10 };
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.isNewUser).toBe(true);
    expect(json.checkIn).toEqual({ streak: 1, goldAwarded: 10 });
    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: `celo-${WALLET.replace(/^0x/, "")}@wallet.thooon.com`,
        email_confirm: true,
      })
    );
    expect(mockRpc).toHaveBeenCalledWith(
      "record_celo_checkin",
      expect.objectContaining({ p_profile_id: USER_ID, p_wallet: WALLET })
    );
  });

  it("200 via selfProof: linka wallet, sem RPC de check-in", async () => {
    state.challenge = { ...checkInChallenge(), method: "selfProof" };
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.checkIn).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("200 via signature: linka wallet, sem RPC de check-in", async () => {
    state.challenge = { ...checkInChallenge(), method: "signature" };
    const res = await POST(makeRequest({ signature: SIGNATURE, nonce: NONCE }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tokenHash).toBe("tok_hash_123");
    expect(json.checkIn).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockDeleteCache).toHaveBeenCalled();
  });

  it("403 quando a assinatura não bate com a wallet do challenge", async () => {
    state.challenge = { ...checkInChallenge(), method: "signature" };
    state.signatureValid = false;
    const res = await POST(makeRequest({ signature: SIGNATURE, nonce: NONCE }));
    expect(res.status).toBe(403);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockDeleteCache).not.toHaveBeenCalled();
  });

  it("400 quando challenge é signature mas o body manda txHash", async () => {
    state.challenge = { ...checkInChallenge(), method: "signature" };
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(400);
  });

  it("400 quando body manda txHash E signature juntos", async () => {
    const res = await POST(
      makeRequest({ txHash: TX_HASH, signature: SIGNATURE, nonce: NONCE })
    );
    expect(res.status).toBe(400);
  });

  it("409 em wallet_conflict da RPC", async () => {
    state.rpcResult = { success: false, error: "wallet_conflict" };
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(409);
  });

  it("login segue mesmo com already_claimed (corrida benigna), sem gold", async () => {
    state.rpcResult = { success: false, error: "already_claimed" };
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.checkIn).toBeNull();
    expect(json.tokenHash).toBe("tok_hash_123");
  });

  it("409 quando outro verify do mesmo nonce está em andamento (lock)", async () => {
    state.challenge = { ...checkInChallenge(), method: "signature" };
    state.lockAcquired = false;
    const res = await POST(makeRequest({ signature: SIGNATURE, nonce: NONCE }));
    expect(res.status).toBe(409);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockGenerateLink).not.toHaveBeenCalled();
  });

  it("429 quando o cap horário de contas novas estoura", async () => {
    state.signupCount = 9999;
    const res = await POST(makeRequest({ txHash: TX_HASH, nonce: NONCE }));
    expect(res.status).toBe(429);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});
