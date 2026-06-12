/**
 * Shared helpers for /api/celo/* routes.
 */
import { NextResponse } from "next/server";
import { features } from "@/lib/env";

/**
 * Returns a 404 when the Celo check-in feature flag is off (or the contract
 * address is missing). Call at the top of every /api/celo/* handler — the
 * endpoints stay indistinguishable from "not found" until rollout.
 */
export function celoCheckInGate(): Response | null {
  if (!features.celoCheckIn) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}
