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

export class CheckInFlowError extends Error {
  constructor(
    message: string,
    /** código estável para a UI decidir a mensagem (i18n) sem regex no texto */
    public readonly code:
      | "challenge_failed"
      | "already_checked_in"
      | "wallet_conflict"
      | "verify_failed"
      | "verify_timeout"
  ) {
    super(message);
    this.name = "CheckInFlowError";
  }
}

/**
 * Pede o nonce single-use para esta wallet. 429 = já fez check-in hoje
 * (o servidor recusa emitir challenge de revert garantido); 409 = wallet
 * pertence a outro perfil.
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
    throw new CheckInFlowError("Already checked in today", "already_checked_in");
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

const VERIFY_MAX_ATTEMPTS = 20; // ~40s com retryAfterMs=2000 — sobra p/ 2 confirmações em blocos de ~1s
const VERIFY_DEFAULT_RETRY_MS = 2000;

/**
 * Polling do /verify até o servidor confirmar a tx (202 = receipt ainda não
 * visível ou < 2 confirmações). O nonce só é consumido no sucesso, então
 * repetir a chamada é seguro.
 */
export async function verifyCheckInTx(
  authedFetch: AuthedFetch,
  params: { txHash: `0x${string}`; nonce: string },
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<CheckInSuccess> {
  for (let attempt = 0; attempt < VERIFY_MAX_ATTEMPTS; attempt++) {
    const res = await authedFetch("/api/celo/check-in/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });

    if (res.status === 202) {
      const body = (await res.json().catch(() => null)) as {
        retryAfterMs?: number;
      } | null;
      await sleep(body?.retryAfterMs ?? VERIFY_DEFAULT_RETRY_MS);
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
  // definitiva — o nonce vive 30 min e o usuário pode tentar de novo.
  throw new CheckInFlowError(
    "Transaction not confirmed yet — try again in a moment",
    "verify_timeout"
  );
}

/**
 * Fluxo completo: challenge → envia tx (função do chamador) → verify.
 * `sendTx` recebe o challenge e devolve o txHash — MiniPay usa o provider
 * injetado cru, desktop usa thirdweb; ninguém mais conhece essa diferença.
 */
export async function performCheckIn(
  authedFetch: AuthedFetch,
  walletAddress: string,
  sendTx: (challenge: CheckInChallenge) => Promise<`0x${string}`>
): Promise<CheckInSuccess> {
  const challenge = await requestCheckInChallenge(authedFetch, walletAddress);
  const txHash = await sendTx(challenge);
  return verifyCheckInTx(authedFetch, { txHash, nonce: challenge.nonce });
}
