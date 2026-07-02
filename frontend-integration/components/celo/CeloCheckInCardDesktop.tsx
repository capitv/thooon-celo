"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useActiveAccount,
  useConnectModal,
  useSendTransaction,
} from "thirdweb/react";
import { getContract, prepareContractCall } from "thirdweb";
import { getRpcClient, eth_getBalance } from "thirdweb/rpc";
import { useAuth } from "@/components/providers/AuthProvider";
import { fetchWithAuthRetry } from "@/lib/auth/fetchWithAuthRetry";
import { thirdwebClient } from "@/lib/thirdweb";
import { celo } from "@/lib/thirdweb/chains";
import { isMiniPayEnv } from "@/lib/minipay";
import CheckInCardShell from "@/components/celo/CheckInCardShell";
import {
  performCheckIn,
  pollCheckInVerification,
  CheckInFlowError,
  type CheckInChallenge,
  type CheckInStatusResponse,
  type CheckInSuccess,
  type PendingCheckInTx,
} from "@/lib/celo/checkinFlow";
import { requestGasDrop, GasDropError } from "@/lib/celo/gasDropClient";
import { GAS_DROP_RECIPIENT_MAX_BALANCE_WEI } from "@/lib/celo/gasDropConfig";

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

async function fetchCeloBalance(address: string): Promise<bigint> {
  const rpc = getRpcClient({ client: thirdwebClient, chain: celo });
  return eth_getBalance(rpc, { address: address as `0x${string}` });
}

/** Espera o drop aparecer no saldo (backoff 2s→6s, ~40s; retorna o último lido). */
async function waitForGas(address: string): Promise<bigint> {
  let balance = 0n;
  for (let attempt = 0; attempt < 9; attempt++) {
    balance = await fetchCeloBalance(address);
    if (balance >= GAS_DROP_RECIPIENT_MAX_BALANCE_WEI) return balance;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(2000 * 1.3 ** attempt, 6000))
    );
  }
  return balance;
}

/**
 * Tx pendente persistida por wallet+dia UTC: sobrevive a reload dentro do
 * TTL do nonce (30 min), para a retomada do verify nunca virar uma segunda
 * tx do dia (que o contrato reverte).
 */
const PENDING_TX_KEY_PREFIX = "celo-checkin:pending:";

function pendingTxKey(address: string): string {
  return `${PENDING_TX_KEY_PREFIX}${address.toLowerCase()}:${new Date().toISOString().slice(0, 10)}`;
}

function loadPendingTx(address: string): PendingCheckInTx | null {
  try {
    const raw = localStorage.getItem(pendingTxKey(address));
    return raw ? (JSON.parse(raw) as PendingCheckInTx) : null;
  } catch {
    return null;
  }
}

function savePendingTx(address: string, tx: PendingCheckInTx | null): void {
  try {
    if (tx) localStorage.setItem(pendingTxKey(address), JSON.stringify(tx));
    else localStorage.removeItem(pendingTxKey(address));
  } catch {
    // localStorage bloqueado — retomada só não sobrevive a reload
  }
}

type CardMode = "connect" | "mismatch" | "getGas" | "checkIn" | "resume";

/**
 * Card de check-in diário on-chain (Celo) para o jogo DESKTOP/browser —
 * irmão do CeloCheckInCard (MiniPay). Mesmo backend (challenge/verify),
 * outra wallet: aqui a tx sai pela wallet thirdweb do jogador (MetaMask,
 * Rabby, WalletConnect...), com switch automático para a Celo Mainnet no
 * envio. Gas em CELO nativo — wallet zerada ganha um gas drop (0.02 CELO,
 * uma vez por conta/wallet) pelo botão "Get gas", então o jogador nunca sai
 * do jogo pra comprar troco.
 *
 * Renderiza null dentro do MiniPay (lá o CeloCheckInCard cobre) e em
 * qualquer estado não elegível — pode montar em qualquer página do jogo.
 */
export default function CeloCheckInCardDesktop() {
  const account = useActiveAccount();
  const { connect } = useConnectModal();
  const { mutateAsync: sendTransaction } = useSendTransaction();
  const { isAuthenticated, session } = useAuth();

  const [status, setStatus] = useState<CheckInStatusResponse | null>(null);
  // null = desconhecido (carregando ou RPC falhou). Desconhecido NÃO esconde
  // o gas drop pra sempre: erro de saldo insuficiente no envio rebaixa pra
  // false e o botão "Get gas" aparece (recuperação sem depender do RPC).
  const [hasEnoughGas, setHasEnoughGas] = useState<boolean | null>(null);
  const [pendingTx, setPendingTx] = useState<PendingCheckInTx | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  const [justClaimed, setJustClaimed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Drop definitivamente indisponível (inelegível/já recebido) — transientes
  // (cap diário, 5xx) NÃO travam: só mostram mensagem e permitem retry.
  const [gasDropBlocked, setGasDropBlocked] = useState(false);
  // Evita null-check de window no render (SSR): só true pós-mount fora do MiniPay
  const [isDesktopEnv, setIsDesktopEnv] = useState(false);

  const accessToken = session?.access_token ?? null;
  const address = account?.address ?? null;

  useEffect(() => {
    setIsDesktopEnv(!isMiniPayEnv());
  }, []);

  const authedFetch = useCallback(
    (url: string, init?: RequestInit) =>
      fetchWithAuthRetry(url, init ?? { method: "GET" }, accessToken ?? ""),
    [accessToken]
  );

  // Status por usuário + wallet: refaz quando a wallet conecta/troca, para
  // o guard de mismatch enxergar o linkedWallet mais fresco antes da tx.
  useEffect(() => {
    if (!isDesktopEnv || !isAuthenticated || !accessToken) return;
    let cancelled = false;
    authedFetch("/api/celo/check-in/status", { method: "GET" })
      .then(async (res) => {
        if (!res.ok) return null; // 404 = feature off
        return (await res.json()) as CheckInStatusResponse;
      })
      .then((data) => {
        if (!cancelled && data?.enabled) setStatus(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isDesktopEnv, isAuthenticated, accessToken, authedFetch, address]);

  // Saldo de gas + tx pendente da wallet conectada. Dep é o ADDRESS (string
  // estável), não o objeto account — thirdweb re-emite referências novas.
  useEffect(() => {
    if (!isDesktopEnv || !address) {
      setHasEnoughGas(null);
      setPendingTx(null);
      return;
    }
    setPendingTx(loadPendingTx(address));
    let cancelled = false;
    fetchCeloBalance(address)
      .then((balance) => {
        if (!cancelled)
          setHasEnoughGas(balance >= GAS_DROP_RECIPIENT_MAX_BALANCE_WEI);
      })
      .catch(() => {
        // RPC falhou: desconhecido. Mostra check-in (não bloqueia a feature);
        // se a wallet acusar saldo insuficiente, o handler rebaixa pra false.
        if (!cancelled) setHasEnoughGas(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktopEnv, address]);

  const celebrate = useCallback(() => {
    setCelebrating(true);
    setJustClaimed(true);
    window.setTimeout(() => setCelebrating(false), 1800);
    window.setTimeout(() => setDismissed(true), 2600);
  }, []);

  const applySuccess = useCallback(
    (result: CheckInSuccess, wallet: string) => {
      savePendingTx(wallet, null);
      setPendingTx(null);
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              checkedInToday: true,
              currentStreak: result.streak,
              linkedWallet: wallet,
            }
          : prev
      );
      setMessage(`+${result.goldAwarded} gold!`);
      celebrate();
    },
    [celebrate]
  );

  /** Envia checkIn(nonce) pela wallet thirdweb; o hook troca a chain sozinho. */
  const sendViaThirdweb = useCallback(
    async (challenge: CheckInChallenge): Promise<`0x${string}`> => {
      const contract = getContract({
        client: thirdwebClient,
        chain: celo,
        address: challenge.contractAddress,
      });
      const call = prepareContractCall({
        contract,
        method: "function checkIn(bytes32 nonce)",
        params: [challenge.nonce],
      });
      const receipt = await sendTransaction(call);
      return receipt.transactionHash;
    },
    [sendTransaction]
  );

  const handleConnect = useCallback(async () => {
    try {
      await connect({ client: thirdwebClient, chain: celo });
    } catch {
      // modal fechado sem conectar — sem erro na UI
    }
  }, [connect]);

  const handleGetGas = useCallback(async () => {
    if (busy || !address) return;
    setBusy(true);
    setMessage(null);
    try {
      await requestGasDrop(authedFetch, address);
      setMessage("Gas on the way...");
      const balance = await waitForGas(address);
      setHasEnoughGas(balance >= GAS_DROP_RECIPIENT_MAX_BALANCE_WEI);
      setMessage(null);
    } catch (error) {
      if (error instanceof GasDropError) {
        if (error.code === "balance_sufficient") {
          // Servidor viu saldo que o card não viu — resincroniza.
          setHasEnoughGas(true);
          setMessage(null);
        } else if (error.code === "already_received") {
          // Drop pode ter saído segundos atrás (double-click, timeout do
          // waitForGas anterior) — espera o saldo antes de desistir.
          setMessage("Gas on the way...");
          const balance = await waitForGas(address).catch(() => 0n);
          const funded = balance >= GAS_DROP_RECIPIENT_MAX_BALANCE_WEI;
          setHasEnoughGas(funded);
          if (!funded) {
            setGasDropBlocked(true);
            setMessage(error.message);
          } else {
            setMessage(null);
          }
        } else if (error.code === "not_eligible") {
          setGasDropBlocked(true);
          setMessage(error.message);
        } else {
          // daily_cap / drop_failed: transiente — mensagem, botão continua.
          setMessage(error.message);
        }
      } else {
        setMessage("Something went wrong — try again");
      }
    }
    setBusy(false);
  }, [busy, address, authedFetch]);

  const handleCheckIn = useCallback(async () => {
    if (busy || !address) return;
    setBusy(true);
    setMessage(null);
    try {
      // Tx pendente = retomar o polling do MESMO txHash. Challenge novo aqui
      // geraria a segunda tx do dia (revert garantido) com a primeira órfã.
      const result = pendingTx
        ? await pollCheckInVerification(authedFetch, pendingTx)
        : await performCheckIn(authedFetch, address, sendViaThirdweb);
      applySuccess(result, address);
    } catch (error) {
      if (error instanceof CheckInFlowError) {
        if (error.code === "verify_timeout" && error.pendingTx) {
          savePendingTx(address, error.pendingTx);
          setPendingTx(error.pendingTx);
        } else if (error.code === "already_checked_in") {
          savePendingTx(address, null);
          setPendingTx(null);
          setStatus((prev) =>
            prev ? { ...prev, checkedInToday: true } : prev
          );
        }
        setMessage(error.message);
      } else if (/insufficient|exceeds.*balance|gas required/i.test(String(error))) {
        // Wallet sem gas que o RPC não detectou (falha/atraso na leitura de
        // saldo) — oferece o drop em vez do beco sem saída.
        setHasEnoughGas(false);
        setMessage(null);
      } else if (/rejected|denied|cancelled|declined/i.test(String(error))) {
        // usuário cancelou na wallet — sem tx, sem drama
        setMessage(null);
      } else {
        setMessage("Something went wrong — try again");
      }
    }
    setBusy(false);
  }, [busy, address, pendingTx, authedFetch, sendViaThirdweb, applySuccess]);

  if (!isDesktopEnv || !isAuthenticated || !status) return null;
  if (dismissed) return null;
  if (status.checkedInToday && !justClaimed) return null;

  // Wallet já vinculada ao perfil e outra conectada: pede a certa em vez de
  // deixar o challenge/verify falhar depois da fee.
  const walletMismatch = Boolean(
    address &&
      status.linkedWallet &&
      address.toLowerCase() !== status.linkedWallet.toLowerCase()
  );

  // Estado único dirige subtítulo E botão — nunca divergem.
  const mode: CardMode = !address
    ? "connect"
    : walletMismatch
      ? "mismatch"
      : pendingTx
        ? "resume"
        : hasEnoughGas === false && !gasDropBlocked
          ? "getGas"
          : "checkIn";

  const subtitle = status.checkedInToday
    ? `✓ Day ${status.currentStreak} complete`
    : mode === "mismatch"
      ? `Connect ${shortAddress(status.linkedWallet!)}`
      : mode === "resume"
        ? "Confirming your check-in..."
        : mode === "getGas"
          ? "Free gas for your first check-in"
          : `Streak ${status.currentStreak} → +${status.nextReward} gold`;

  const primaryButtonClass =
    "shrink-0 rounded-md bg-gradient-to-r from-amber-400 to-amber-500 px-3 py-2 font-pixel text-[10px] uppercase tracking-wider text-black transition-opacity " +
    (busy ? "opacity-60 cursor-not-allowed" : "hover:opacity-90");

  const action = status.checkedInToday ? null : mode === "connect" ||
    mode === "mismatch" ? (
    <button
      type="button"
      onClick={handleConnect}
      className="shrink-0 rounded-md border border-amber-400/70 px-3 py-2 font-pixel text-[10px] uppercase tracking-wider text-amber-300 transition-colors hover:bg-amber-400/10"
    >
      Connect
    </button>
  ) : mode === "getGas" ? (
    <button
      type="button"
      onClick={handleGetGas}
      disabled={busy}
      className={
        "shrink-0 rounded-md border border-emerald-400/70 px-3 py-2 font-pixel text-[10px] uppercase tracking-wider text-emerald-300 transition-colors " +
        (busy ? "opacity-60 cursor-not-allowed" : "hover:bg-emerald-400/10")
      }
    >
      {busy ? "..." : "Get gas"}
    </button>
  ) : (
    <button
      type="button"
      onClick={handleCheckIn}
      disabled={busy}
      className={primaryButtonClass}
    >
      {busy ? "..." : mode === "resume" ? "Resume" : "Check in"}
    </button>
  );

  return (
    <CheckInCardShell
      title="Daily Check-in · Celo"
      subtitle={subtitle}
      message={message}
      celebrating={celebrating}
      action={action}
    />
  );
}
