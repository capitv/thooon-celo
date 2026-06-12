import {
  getRpcClient,
  eth_getTransactionReceipt,
  eth_blockNumber,
} from "thirdweb/rpc";
import { prepareEvent, parseEventLogs } from "thirdweb";
import { thirdwebClient } from "@/lib/thirdweb";
import { celo } from "@/lib/thirdweb/chains";
import { normalizeAddress } from "@/lib/utils";
import { ECONOMY_LIMITS } from "@/lib/staking/economy-guardrails";

/**
 * Check-in diário on-chain na Celo (Proof of Ship / MiniPay).
 *
 * O MiniPay não suporta assinatura de mensagem (personal_sign), então a
 * transação de check-in cumpre papel duplo: prova posse da chave (substitui
 * o SIWE) e gera a atividade on-chain recorrente. O servidor emite um nonce
 * vinculado ao userId (Redis), o cliente envia `checkIn(nonce)` e o servidor
 * verifica o receipt + evento via RPC antes de linkar a wallet e creditar.
 */

// 30 min — bem acima dos 120s do SIWE: o usuário precisa broadcastar uma tx
// num webview mobile e o servidor precisa ver o receipt. Nonce é single-use,
// então a janela maior não amplia replay.
export const CELO_CHECKIN_NONCE_TTL_SECONDS = 30 * 60;
export const CELO_CHECKIN_NONCE_PREFIX = "celo-checkin:nonce:";

// Confirmações mínimas antes de aceitar o receipt (Celo L2 = blocos de ~1s,
// custo de latência desprezível).
const MIN_CONFIRMATIONS = 2n;

export interface CeloCheckInChallenge {
  nonce: string;
  userId: string;
  walletAddress: string;
  issuedAt: string;
}

export type CheckInVerification =
  | { status: "pending" }
  | { status: "failed" }
  | {
      status: "confirmed";
      account: string;
      nonce: string;
      day: number;
      streak: number;
      blockNumber: bigint;
    };

export const CHECKIN_EVENT = prepareEvent({
  signature:
    "event CheckIn(address indexed account, bytes32 indexed nonce, uint256 day, uint32 streak)",
});

export function getCeloCheckInNonceKey(nonce: string): string {
  return `${CELO_CHECKIN_NONCE_PREFIX}${nonce}`;
}

/** Recompensa do check-in: base + bônus por streak, com teto (guardrails). */
export function calcCheckInReward(streakDay: number): number {
  const { baseGold, goldPerStreakDay, maxGoldPerCheckIn } =
    ECONOMY_LIMITS.celoCheckIn;
  return Math.min(
    baseGold + (streakDay - 1) * goldPerStreakDay,
    maxGoldPerCheckIn
  );
}

export function getCheckInContractAddress(): string | null {
  const address = process.env.NEXT_PUBLIC_CELO_CHECKIN_CONTRACT_ADDRESS;
  return address ? normalizeAddress(address) : null;
}

/**
 * Verifica uma tx de check-in na Celo. Nunca confia em dados vindos do
 * cliente além do hash — tudo é lido do RPC.
 */
export async function verifyCheckInTx(
  txHash: `0x${string}`
): Promise<CheckInVerification> {
  const contractAddress = getCheckInContractAddress();
  if (!contractAddress) {
    throw new Error("Celo check-in contract address not configured");
  }

  const rpc = getRpcClient({ client: thirdwebClient, chain: celo });

  let receipt;
  try {
    receipt = await eth_getTransactionReceipt(rpc, { hash: txHash });
  } catch {
    // thirdweb lança quando o receipt ainda não existe (tx pendente/desconhecida)
    return { status: "pending" };
  }

  if (!receipt) return { status: "pending" };
  if (receipt.status !== "success") return { status: "failed" };

  // Confirmações: protege contra aceitar um bloco reorganizado.
  const head = await eth_blockNumber(rpc);
  if (head - receipt.blockNumber < MIN_CONFIRMATIONS) {
    return { status: "pending" };
  }

  const contractLogs = receipt.logs.filter(
    (log) => normalizeAddress(log.address) === contractAddress
  );
  const events = parseEventLogs({
    logs: contractLogs,
    events: [CHECKIN_EVENT],
  });

  const checkInEvent = events[0];
  if (!checkInEvent) return { status: "failed" };

  const { account, nonce, day, streak } = checkInEvent.args as {
    account: string;
    nonce: `0x${string}`;
    day: bigint;
    streak: number;
  };

  return {
    status: "confirmed",
    account: normalizeAddress(account),
    nonce: nonce.toLowerCase(),
    day: Number(day),
    streak: Number(streak),
    blockNumber: receipt.blockNumber,
  };
}
