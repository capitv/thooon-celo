/**
 * Fluxo de check-in do lado do CLIENTE, agnóstico de wallet.
 *
 * O backend nunca soube de MiniPay: /challenge emite nonce vinculado ao
 * userId + wallet declarada e /verify lê a tx do RPC. Este módulo isola o
 * que é comum a qualquer ambiente (MiniPay webview, desktop com wallet
 * injetada/thirdweb): pedir o challenge e fazer polling do verify. O envio
 * da tx em si fica com o chamador — é a única parte que muda por wallet.
 *
 * Não importa nada de thirdweb/viem: precisa poder entrar tanto no bundle
 * leve do /mini quanto no bundle do jogo desktop.
 */

/** fetch autenticado (ex.: fetchWithAuthRetry com o accessToken já aplicado) */
export type AuthedFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface CheckInChallenge {
  nonce: `0x${string}`;
  contractAddress: string;
  chainId: number;
  expiresInSeconds: number;
}

export interface CheckInSuccess {
  streak: number;
  goldAwarded: number;
  walletLinked: string;
}

/** Resposta de GET /api/celo/check-in/status — compartilhada pelos dois cards. */
export interface CheckInStatusResponse {
  enabled: boolean;
  linkedWallet: string | null;
  checkedInToday: boolean;
  currentStreak: number;
  nextReward: number;
  contractAddress?: string | null;
}

/** Tx broadcastada aguardando confirmação — retomável (nonce vive 30 min). */
export interface PendingCheckInTx {
  txHash: `0x${string}`;
  nonce: string;
}

export class CheckInFlowError extends Error {
  constructor(
    message: string,
    /** código estável para a UI decidir a mensagem (i18n) sem regex no texto */
    public readonly code:
      | "challenge_failed"
      | "already_checked_in"
      | "wallet_conflict"
      | "rate_limited"
      | "verify_failed"
      | "verify_timeout",
    /**
     * Presente em verify_timeout: a tx JÁ FOI broadcastada. O chamador DEVE
     * retomar com pollCheckInVerification(pendingTx) em vez de começar um
     * fluxo novo — challenge novo geraria uma segunda tx que o contrato
     * reverte (AlreadyCheckedInToday) enquanto a primeira fica órfã.
     */
    public readonly pendingTx?: PendingCheckInTx
  ) {
    super(message);
    this.name = "CheckInFlowError";
  }
}

/**
 * Pede o nonce single-use para esta wallet. O 429 é ambíguo no protocolo
 * (rate limiter E "já fez check-in hoje" usam o mesmo status) — desambigua
 * pelo `code` do body; sem code, assume rate limit (transiente, retryable),
 * NUNCA already_checked_in: marcar check-in feito por engano esconde o card
 * o resto da sessão.
 */
export async function requestCheckInChallenge(
  authedFetch: AuthedFetch,
  walletAddress: string
): Promise<CheckInChallenge> {
  const res = await authedFetch("/api/celo/check-in/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress }),
  });

  if (res.status === 429) {
    const body = (await res.json().catch(() => null)) as {
      code?: string;
    } | null;
    if (body?.code === "already_checked_in") {
      throw new CheckInFlowError(
        "Already checked in today",
        "already_checked_in"
      );
    }
    throw new CheckInFlowError(
      "Too many requests — wait a moment",
      "rate_limited"
    );
  }
  if (res.status === 409) {
    throw new CheckInFlowError(
      "Wallet already linked to another account",
      "wallet_conflict"
    );
  }
  if (!res.ok) {
    throw new CheckInFlowError("Could not start check-in", "challenge_failed");
  }

  return (await res.json()) as CheckInChallenge;
}

// Backoff: 2s→8s (cap), ~70s de janela total. Rate limit (429) no meio do
// polling também só espera e continua — a tx está on-chain, desistir cedo
// é o único jeito de perder.
const VERIFY_MAX_ATTEMPTS = 15;
const VERIFY_BASE_RETRY_MS = 2000;
const VERIFY_MAX_RETRY_MS = 8000;

function verifyRetryDelay(attempt: number, serverHintMs?: number): number {
  const backoff = Math.min(
    VERIFY_BASE_RETRY_MS * 1.35 ** attempt,
    VERIFY_MAX_RETRY_MS
  );
  return Math.max(serverHintMs ?? 0, Math.round(backoff));
}

/**
 * Polling do /verify até o servidor confirmar a tx (202 = receipt ainda não
 * visível ou < 2 confirmações; 429 = rate limit, espera e segue). O nonce só
 * é consumido no sucesso, então repetir a chamada é seguro — inclusive numa
 * retomada posterior com o MESMO txHash/nonce (ver PendingCheckInTx).
 */
export async function pollCheckInVerification(
  authedFetch: AuthedFetch,
  pendingTx: PendingCheckInTx,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<CheckInSuccess> {
  for (let attempt = 0; attempt < VERIFY_MAX_ATTEMPTS; attempt++) {
    const res = await authedFetch("/api/celo/check-in/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pendingTx),
    });

    if (res.status === 202 || res.status === 429) {
      const body = (await res.json().catch(() => null)) as {
        retryAfterMs?: number;
      } | null;
      await sleep(verifyRetryDelay(attempt, body?.retryAfterMs));
      continue;
    }

    if (res.status === 409) {
      throw new CheckInFlowError("Already checked in today", "already_checked_in");
    }

    if (!res.ok) {
      throw new CheckInFlowError(
        "Check-in verification failed",
        "verify_failed"
      );
    }

    const body = (await res.json()) as {
      streak?: number;
      goldAwarded?: number;
      walletLinked?: string;
    };
    return {
      streak: body.streak ?? 1,
      goldAwarded: body.goldAwarded ?? 0,
      walletLinked: body.walletLinked ?? "",
    };
  }

  // Tx broadcastada mas não confirmada dentro da janela: NÃO é falha
  // definitiva — carrega o pendingTx para o chamador retomar o polling.
  throw new CheckInFlowError(
    "Transaction not confirmed yet — try again in a moment",
    "verify_timeout",
    pendingTx
  );
}

/**
 * Fluxo completo: challenge → envia tx (função do chamador) → verify.
 * `sendTx` recebe o challenge e devolve o txHash — MiniPay usa o provider
 * injetado cru, desktop usa thirdweb; ninguém mais conhece essa diferença.
 *
 * verify_timeout carrega o pendingTx: o chamador deve guardá-lo e retomar
 * com pollCheckInVerification — nunca chamar performCheckIn de novo com uma
 * tx pendente (segunda tx do dia reverte no contrato).
 */
export async function performCheckIn(
  authedFetch: AuthedFetch,
  walletAddress: string,
  sendTx: (challenge: CheckInChallenge) => Promise<`0x${string}`>
): Promise<CheckInSuccess> {
  const challenge = await requestCheckInChallenge(authedFetch, walletAddress);
  const txHash = await sendTx(challenge);
  return pollCheckInVerification(authedFetch, {
    txHash,
    nonce: challenge.nonce,
  });
}
