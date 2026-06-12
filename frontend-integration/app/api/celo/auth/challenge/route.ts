import { NextRequest, NextResponse } from "next/server";
import { isSupabaseAdminConfigured } from "@/lib/supabase";
import { supabaseAdmin } from "@/lib/supabase/server";
import { withRateLimit, RATE_LIMITS } from "@/lib/rateLimit";
import { setCache } from "@/lib/redisCache";
import { CeloCheckInChallengeSchema } from "@/lib/validation/schemas";
import { celoCheckInGate } from "@/app/api/celo/_helpers";
import { getCheckInContractAddress } from "@/lib/celo/checkin";
import {
  CELO_AUTH_NONCE_TTL_SECONDS,
  getCeloAuthNonceKey,
  type CeloAuthChallenge,
} from "@/lib/celo/auth";
import { normalizeAddress } from "@/lib/utils";

/**
 * POST /api/celo/auth/challenge — "Sign in with MiniPay", passo 1.
 *
 * ANÔNIMA (usuário ainda não tem sessão). Emite nonce vinculado à wallet
 * declarada. Método de prova: "signature" (EIP-712 via signTypedData —
 * grátis, instantâneo). Os métodos por tx (checkIn/selfProof) seguem
 * aceitos no verify para compatibilidade, mas não são mais emitidos:
 * MiniPay nega eth_sendTransaction para contratos com -32604.
 */
export async function POST(req: NextRequest) {
  const gated = celoCheckInGate();
  if (gated) return gated;

  // Sem usuário pra chavear — limita por IP (tier crítico).
  const rateLimitCheck = await withRateLimit(req, RATE_LIMITS.CRITICAL);
  if (!rateLimitCheck.allowed) return rateLimitCheck.response;

  if (!isSupabaseAdminConfigured() || !supabaseAdmin) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = CeloCheckInChallengeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const walletAddress = normalizeAddress(parsed.data.walletAddress);
  const method = "signature" as const;

  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const nonce = `0x${Array.from(nonceBytes, (b) =>
    b.toString(16).padStart(2, "0")
  ).join("")}`;

  const challenge: CeloAuthChallenge = {
    nonce,
    walletAddress,
    method,
    issuedAt: new Date().toISOString(),
  };

  const cached = await setCache(
    getCeloAuthNonceKey(nonce),
    challenge,
    CELO_AUTH_NONCE_TTL_SECONDS
  );
  if (!cached) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  return NextResponse.json({
    nonce,
    method,
    // issuedAt entra no payload EIP-712 assinado — o cliente ecoa o valor
    // exato; o verify rebuilda o payload a partir do challenge no Redis.
    issuedAt: challenge.issuedAt,
    contractAddress: getCheckInContractAddress(),
    chainId: 42220,
    expiresInSeconds: CELO_AUTH_NONCE_TTL_SECONDS,
  });
}
