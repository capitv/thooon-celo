import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, isSupabaseAdminConfigured } from "@/lib/supabase";
import { supabaseAdmin } from "@/lib/supabase/server";
import { withRateLimit, RATE_LIMITS } from "@/lib/rateLimit";
import { setCache } from "@/lib/redisCache";
import { CeloCheckInChallengeSchema } from "@/lib/validation/schemas";
import { celoCheckInGate } from "@/app/api/celo/_helpers";
import {
  CELO_CHECKIN_NONCE_TTL_SECONDS,
  getCeloCheckInNonceKey,
  getCheckInContractAddress,
  type CeloCheckInChallenge,
} from "@/lib/celo/checkin";
import { normalizeAddress } from "@/lib/utils";

/**
 * POST /api/celo/check-in/challenge
 *
 * Emite um nonce single-use vinculado ao userId + wallet declarada. O cliente
 * envia `checkIn(nonce)` no contrato ThooonCheckIn (Celo) e depois chama
 * /verify com o txHash. A tx substitui o SIWE no MiniPay (que não suporta
 * assinatura de mensagem): incluir o nonce no evento prova posse da chave.
 */
export async function POST(req: NextRequest) {
  const gated = celoCheckInGate();
  if (gated) return gated;

  const { user, error: authError } = await getAuthenticatedUser(req);
  if (authError || !user) {
    return NextResponse.json(
      { error: authError || "Authentication required" },
      { status: 401 }
    );
  }

  const rateLimitCheck = await withRateLimit(
    req,
    RATE_LIMITS.CRITICAL,
    `user:${user.id}:celo-challenge`
  );
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

  // Pré-checagem de conflito: wallet Celo já vinculada a outro perfil.
  // (A RPC record_celo_checkin re-checa atomicamente — isto poupa o usuário
  // de pagar a network fee de uma tx que vai falhar na verificação.)
  const { data: conflict } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("celo_wallet_address", walletAddress)
    .neq("id", user.id)
    .limit(1)
    .maybeSingle();

  if (conflict) {
    return NextResponse.json(
      { error: "Wallet already linked to another account" },
      { status: 409 }
    );
  }

  // Nunca emitir challenge para um dia já reclamado — evita tx de revert.
  const todayUTC = new Date().toISOString().slice(0, 10);
  const { data: todayCheckIn } = await supabaseAdmin
    .from("celo_checkins")
    .select("id")
    .eq("profile_id", user.id)
    .eq("check_day", todayUTC)
    .limit(1)
    .maybeSingle();

  if (todayCheckIn) {
    return NextResponse.json(
      { error: "Already checked in today" },
      { status: 429 }
    );
  }

  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const nonce = `0x${Array.from(nonceBytes, (b) =>
    b.toString(16).padStart(2, "0")
  ).join("")}`;

  const challenge: CeloCheckInChallenge = {
    nonce,
    userId: user.id,
    walletAddress,
    issuedAt: new Date().toISOString(),
  };

  const cached = await setCache(
    getCeloCheckInNonceKey(nonce),
    challenge,
    CELO_CHECKIN_NONCE_TTL_SECONDS
  );
  if (!cached) {
    return NextResponse.json(
      { error: "Service unavailable" },
      { status: 503 }
    );
  }

  return NextResponse.json({
    nonce,
    contractAddress: getCheckInContractAddress(),
    chainId: 42220,
    expiresInSeconds: CELO_CHECKIN_NONCE_TTL_SECONDS,
  });
}
