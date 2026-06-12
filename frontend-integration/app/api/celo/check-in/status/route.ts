import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, isSupabaseAdminConfigured } from "@/lib/supabase";
import { supabaseAdmin } from "@/lib/supabase/server";
import { withRateLimit, RATE_LIMITS } from "@/lib/rateLimit";
import { celoCheckInGate } from "@/app/api/celo/_helpers";
import { getCheckInContractAddress } from "@/lib/celo/checkin";
import { ECONOMY_LIMITS } from "@/lib/staking/economy-guardrails";

// Lê Authorization header por request — nunca pré-renderizar.
export const dynamic = "force-dynamic";

function calcReward(streakDay: number): number {
  const { baseGold, goldPerStreakDay, maxGoldPerCheckIn } =
    ECONOMY_LIMITS.celoCheckIn;
  return Math.min(
    baseGold + (streakDay - 1) * goldPerStreakDay,
    maxGoldPerCheckIn
  );
}

function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/celo/check-in/status
 *
 * Estado do check-in Celo para o usuário autenticado. O cliente consulta
 * isto ANTES de pedir uma tx — usuário nunca paga network fee de um revert
 * garantido (AlreadyCheckedInToday).
 */
export async function GET(req: NextRequest) {
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
    RATE_LIMITS.READ,
    `user:${user.id}:celo-status`
  );
  if (!rateLimitCheck.allowed) return rateLimitCheck.response;

  if (!isSupabaseAdminConfigured() || !supabaseAdmin) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  const now = new Date();
  const todayUTC = utcDateStr(now);
  const yesterdayUTC = utcDateStr(
    new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)
    )
  );

  const [{ data: profile }, { data: lastCheckIn }] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("celo_wallet_address")
      .eq("id", user.id)
      .maybeSingle(),
    supabaseAdmin
      .from("celo_checkins")
      .select("streak_day, check_day")
      .eq("profile_id", user.id)
      .order("check_day", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const lastDay = lastCheckIn?.check_day ?? null;
  const checkedInToday = lastDay === todayUTC;
  const streakAlive = lastDay === todayUTC || lastDay === yesterdayUTC;
  const currentStreak =
    streakAlive && lastCheckIn ? lastCheckIn.streak_day : 0;
  const nextStreakDay = checkedInToday ? currentStreak : currentStreak + 1;

  return NextResponse.json({
    enabled: true,
    linkedWallet: profile?.celo_wallet_address ?? null,
    checkedInToday,
    currentStreak,
    nextReward: calcReward(nextStreakDay),
    contractAddress: getCheckInContractAddress(),
    chainId: 42220,
  });
}
