import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, isSupabaseAdminConfigured } from "@/lib/supabase";
import { supabaseAdmin } from "@/lib/supabase/server";
import { withRateLimit, RATE_LIMITS } from "@/lib/rateLimit";
import { getCache, deleteCache } from "@/lib/redisCache";
import { CeloCheckInVerifySchema } from "@/lib/validation/schemas";
import { celoCheckInGate } from "@/app/api/celo/_helpers";
import {
  getCeloCheckInNonceKey,
  verifyCheckInTx,
  type CeloCheckInChallenge,
} from "@/lib/celo/checkin";
import { ECONOMY_LIMITS } from "@/lib/staking/economy-guardrails";
import { invalidatePlayerReadCaches } from "@/lib/cache/playerCaches";

function calcReward(streakDay: number): number {
  const { baseGold, goldPerStreakDay, maxGoldPerCheckIn } =
    ECONOMY_LIMITS.celoCheckIn;
  return Math.min(
    baseGold + (streakDay - 1) * goldPerStreakDay,
    maxGoldPerCheckIn
  );
}

/**
 * POST /api/celo/check-in/verify
 *
 * Verifica a tx de check-in na Celo e, numa única transação Postgres
 * (record_celo_checkin): vincula a wallet ao perfil, grava o fato do dia e
 * credita o gold. Ordem das checagens é a história de idempotência:
 * nada é consumido até a verificação on-chain passar.
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
    RATE_LIMITS.CELO_VERIFY,
    `user:${user.id}:celo-verify`
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

  const parsed = CeloCheckInVerifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const txHash = parsed.data.txHash.toLowerCase() as `0x${string}`;
  const nonce = parsed.data.nonce.toLowerCase();

  // 1) Challenge precisa existir e pertencer a este usuário.
  const nonceKey = getCeloCheckInNonceKey(nonce);
  const challenge = await getCache<CeloCheckInChallenge>(nonceKey);
  if (!challenge) {
    return NextResponse.json(
      { error: "Challenge expired or already used" },
      { status: 400 }
    );
  }
  if (challenge.userId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // 2) Verificação on-chain. Nonce NÃO é consumido em pending/failed/erro.
  let verification;
  try {
    verification = await verifyCheckInTx(txHash);
  } catch (error) {
    console.error(
      "[celo-verify] RPC error:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      { error: "Verification temporarily unavailable" },
      { status: 503 }
    );
  }

  if (verification.status === "pending") {
    return NextResponse.json(
      { pending: true, retryAfterMs: 2000 },
      { status: 202 }
    );
  }
  if (verification.status === "failed") {
    return NextResponse.json(
      { error: "Transaction failed or is not a check-in" },
      { status: 400 }
    );
  }

  // 3) Binding anti-spoof: o evento precisa carregar EXATAMENTE o nonce
  //    emitido para este usuário, vindo da wallet declarada no challenge.
  //    Submeter o txHash de outra pessoa falha aqui.
  if (
    verification.nonce !== challenge.nonce.toLowerCase() ||
    verification.account !== challenge.walletAddress
  ) {
    return NextResponse.json(
      { error: "Transaction does not match challenge" },
      { status: 403 }
    );
  }

  // 4) Link + fato + crédito, atômico no Postgres. O streak canônico é
  //    derivado DENTRO da RPC; aqui calculamos o gold esperado a partir do
  //    check-in de ontem (mesma derivação) — a RPC re-clampa por defesa.
  const yesterdayDate = new Date((verification.day - 1) * 86400 * 1000)
    .toISOString()
    .slice(0, 10);
  const { data: yesterdayCheckIn } = await supabaseAdmin
    .from("celo_checkins")
    .select("streak_day")
    .eq("profile_id", user.id)
    .eq("check_day", yesterdayDate)
    .limit(1)
    .maybeSingle();

  const expectedStreak = (yesterdayCheckIn?.streak_day ?? 0) + 1;
  const goldAwarded = calcReward(expectedStreak);
  const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc(
    "record_celo_checkin",
    {
      p_profile_id: user.id,
      p_wallet: challenge.walletAddress,
      p_tx_hash: txHash,
      p_nonce: nonce,
      p_chain_day: verification.day,
      p_gold: goldAwarded,
    }
  );

  if (rpcError) {
    console.error("[celo-verify] record_celo_checkin error:", rpcError.message);
    return NextResponse.json(
      { error: "Failed to record check-in" },
      { status: 500 }
    );
  }

  const result = rpcResult as {
    success: boolean;
    error?: string;
    streak_day?: number;
    gold_awarded?: number;
  } | null;

  if (!result?.success) {
    const code = result?.error;
    if (code === "wallet_conflict") {
      return NextResponse.json(
        { error: "Wallet already linked to another account" },
        { status: 409 }
      );
    }
    if (code === "already_claimed" || code === "tx_already_used") {
      return NextResponse.json(
        { error: "Already checked in today" },
        { status: 409 }
      );
    }
    console.error("[celo-verify] record_celo_checkin failed:", code);
    return NextResponse.json(
      { error: "Failed to record check-in" },
      { status: 500 }
    );
  }

  // 5) Consumo do nonce só após sucesso total.
  await deleteCache(nonceKey);

  await invalidatePlayerReadCaches({ profileId: user.id }).catch(() => {});

  return NextResponse.json({
    success: true,
    walletLinked: challenge.walletAddress,
    streak: result.streak_day ?? 1,
    goldAwarded: result.gold_awarded ?? 0,
  });
}
