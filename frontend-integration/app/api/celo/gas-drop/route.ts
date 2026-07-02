import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, isSupabaseAdminConfigured } from "@/lib/supabase";
import { supabaseAdmin } from "@/lib/supabase/server";
import { withRateLimit, RATE_LIMITS } from "@/lib/rateLimit";
import { CeloGasDropSchema } from "@/lib/validation/schemas";
import { celoCheckInGate } from "@/app/api/celo/_helpers";
import {
  isGasDropConfigured,
  getGasDropAccount,
  recipientHasEnoughGas,
  hotWalletCanFund,
  sendGasDrop,
} from "@/lib/celo/gasDrop";
import {
  GAS_DROP_AMOUNT_WEI,
  GAS_DROP_DAILY_CAP,
  GAS_DROP_MIN_ACCOUNT_AGE_DAYS,
} from "@/lib/celo/gasDropConfig";
import { normalizeAddress } from "@/lib/utils";

/**
 * POST /api/celo/gas-drop
 *
 * Envia 0.02 CELO para a wallet do jogador pagar o gas do check-in desktop.
 * Ordem das checagens = do mais barato/mais provável ao mais caro:
 * flag → auth → rate limit → payload → [idade da conta ∥ cap diário] →
 * [saldo destinatário ∥ saldo hot wallet] (RPC) → reserva (unicidade) →
 * recontagem do cap → envio.
 * A reserva vem ANTES do envio: requests concorrentes morrem no unique
 * index e a hot wallet nunca paga duas vezes; a recontagem pós-reserva
 * fecha o TOCTOU do cap diário sob burst.
 */
export async function POST(req: NextRequest) {
  const gated = celoCheckInGate();
  if (gated) return gated;
  // Mesmo contrato do gate: indistinguível de 404 até o rollout.
  if (!isGasDropConfigured()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

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
    `user:${user.id}:celo-gas-drop`
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

  const parsed = CeloGasDropSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const walletAddress = normalizeAddress(parsed.data.walletAddress);

  // 1) Checagens de banco em paralelo — nenhuma depende da outra.
  const todayStartUTC = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const [{ data: profile }, { count: dropsToday }] = await Promise.all([
    // Anti-sybil: conta precisa de idade mínima. No port, endurecer com
    // progresso de jogo (tutorial/nível) — dado que já existe server-side.
    supabaseAdmin
      .from("profiles")
      .select("created_at")
      .eq("id", user.id)
      .maybeSingle(),
    // Circuit breaker: cap diário global (dia UTC). Pré-checagem barata;
    // a recontagem PÓS-reserva (abaixo) é quem fecha a corrida.
    supabaseAdmin
      .from("celo_gas_drops")
      .select("id", { count: "exact", head: true })
      .gte("created_at", todayStartUTC),
  ]);

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const accountAgeMs = Date.now() - new Date(profile.created_at).getTime();
  if (accountAgeMs < GAS_DROP_MIN_ACCOUNT_AGE_DAYS * 24 * 60 * 60 * 1000) {
    return NextResponse.json(
      { error: "Account not eligible yet", code: "not_eligible" },
      { status: 403 }
    );
  }

  if ((dropsToday ?? 0) >= GAS_DROP_DAILY_CAP) {
    return NextResponse.json(
      { error: "Daily gas drop limit reached — try tomorrow", code: "daily_cap" },
      { status: 429 }
    );
  }

  // 2) Leituras de saldo em paralelo (dois round-trips de RPC independentes).
  const account = getGasDropAccount();
  if (!account) {
    console.error("[celo-gas-drop] hot wallet account unavailable");
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 503 }
    );
  }

  let recipientFunded: boolean;
  let hotWalletFunded: boolean;
  try {
    [recipientFunded, hotWalletFunded] = await Promise.all([
      recipientHasEnoughGas(walletAddress),
      hotWalletCanFund(account),
    ]);
  } catch (error) {
    console.error(
      "[celo-gas-drop] RPC balance error:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 503 }
    );
  }

  // Destinatário já tem gas → não desperdiça o float.
  if (recipientFunded) {
    return NextResponse.json(
      { error: "Wallet already has enough gas", code: "balance_sufficient" },
      { status: 400 }
    );
  }

  // Hot wallet sem float = 503, não 500 — é operacional.
  if (!hotWalletFunded) {
    console.error("[celo-gas-drop] hot wallet cannot fund drop");
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 503 }
    );
  }

  // 3) Reserva ANTES do envio — unique index em profile_id E wallet_address
  //    é quem garante "uma vez na vida" sob concorrência.
  const { data: reservation, error: insertError } = await supabaseAdmin
    .from("celo_gas_drops")
    .insert({
      profile_id: user.id,
      wallet_address: walletAddress,
      amount_wei: GAS_DROP_AMOUNT_WEI.toString(),
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError || !reservation) {
    // 23505 = unique_violation → este perfil OU esta wallet já bebeu.
    if (insertError?.code === "23505") {
      return NextResponse.json(
        { error: "Gas drop already received", code: "already_received" },
        { status: 409 }
      );
    }
    console.error("[celo-gas-drop] reservation error:", insertError?.message);
    return NextResponse.json(
      { error: "Failed to process gas drop" },
      { status: 500 }
    );
  }

  // 4) Recontagem PÓS-reserva fecha o TOCTOU do cap: num burst concorrente,
  //    toda reserva além do cap enxerga a contagem (que agora inclui todas
  //    as reservas do burst) acima do limite e recua ANTES do envio.
  //    Fail-closed: pode recusar um drop no exato limite, nunca estourá-lo.
  const { count: dropsAfterReserve } = await supabaseAdmin
    .from("celo_gas_drops")
    .select("id", { count: "exact", head: true })
    .gte("created_at", todayStartUTC);

  if ((dropsAfterReserve ?? 0) > GAS_DROP_DAILY_CAP) {
    await supabaseAdmin
      .from("celo_gas_drops")
      .delete()
      .eq("id", reservation.id)
      .eq("status", "pending");
    return NextResponse.json(
      { error: "Daily gas drop limit reached — try tomorrow", code: "daily_cap" },
      { status: 429 }
    );
  }

  // 5) Envio. Falhou → libera a reserva (retry permitido). Crash entre envio
  //    e update deixa 'pending' — fecha seguro, nunca paga duas vezes.
  let txHash: `0x${string}`;
  try {
    txHash = await sendGasDrop(account, walletAddress);
  } catch (error) {
    console.error(
      "[celo-gas-drop] send error:",
      error instanceof Error ? error.message : error
    );
    await supabaseAdmin
      .from("celo_gas_drops")
      .delete()
      .eq("id", reservation.id)
      .eq("status", "pending");
    return NextResponse.json(
      { error: "Failed to send gas drop — try again" },
      { status: 502 }
    );
  }

  await supabaseAdmin
    .from("celo_gas_drops")
    .update({ status: "sent", tx_hash: txHash.toLowerCase() })
    .eq("id", reservation.id);

  return NextResponse.json({
    success: true,
    txHash,
    amountWei: GAS_DROP_AMOUNT_WEI.toString(),
  });
}
