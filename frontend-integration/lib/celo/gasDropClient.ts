/**
 * Lado do CLIENTE do gas drop — irmão do checkinFlow: sem thirdweb, só o
 * contrato HTTP com /api/celo/gas-drop, com códigos estáveis pra UI.
 */
import type { AuthedFetch } from "@/lib/celo/checkinFlow";

export class GasDropError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_eligible"
      | "already_received"
      | "balance_sufficient"
      | "daily_cap"
      | "drop_failed"
  ) {
    super(message);
    this.name = "GasDropError";
  }
}

export interface GasDropResult {
  txHash: `0x${string}`;
  amountWei: string;
}

export async function requestGasDrop(
  authedFetch: AuthedFetch,
  walletAddress: string
): Promise<GasDropResult> {
  const res = await authedFetch("/api/celo/gas-drop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress }),
  });

  if (res.ok) {
    const body = (await res.json()) as GasDropResult;
    return body;
  }

  const body = (await res.json().catch(() => null)) as {
    error?: string;
    code?: string;
  } | null;

  const code =
    body?.code === "not_eligible" ||
    body?.code === "already_received" ||
    body?.code === "balance_sufficient" ||
    body?.code === "daily_cap"
      ? body.code
      : "drop_failed";

  throw new GasDropError(body?.error ?? "Gas drop failed", code);
}
