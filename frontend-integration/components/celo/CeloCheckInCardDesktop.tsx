"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
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
import {
  performCheckIn,
  CheckInFlowError,
  type CheckInChallenge,
} from "@/lib/celo/checkinFlow";
import { requestGasDrop, GasDropError } from "@/lib/celo/gasDropClient";
import { GAS_DROP_RECIPIENT_MAX_BALANCE_WEI } from "@/lib/celo/gasDropConfig";

type CheckInStatus = {
  enabled: boolean;
  linkedWallet: string | null;
  checkedInToday: boolean;
  currentStreak: number;
  nextReward: number;
  contractAddress: string | null;
};

const CONFETTI_PALETTE = ["#ffd966", "#fff6e0", "#f59e0b", "#fde68a", "#34d399"];

function makeConfetti(count: number) {
  return Array.from({ length: count }).map((_, i) => ({
    id: i,
    color: CONFETTI_PALETTE[i % CONFETTI_PALETTE.length],
    xDrift: (Math.random() - 0.5) * 280,
    yRise: -(120 + Math.random() * 160),
    rotateEnd: (Math.random() - 0.5) * 720,
    delay: Math.random() * 0.15,
    size: 3 + Math.random() * 3,
  }));
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

async function fetchCeloBalance(address: string): Promise<bigint> {
  const rpc = getRpcClient({ client: thirdwebClient, chain: celo });
  return eth_getBalance(rpc, { address: address as `0x${string}` });
}

/** Espera o drop aparecer no saldo (blocos de ~1s; desiste em ~20s). */
async function waitForGas(address: string): Promise<bigint> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const balance = await fetchCeloBalance(address);
    if (balance >= GAS_DROP_RECIPIENT_MAX_BALANCE_WEI) return balance;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return fetchCeloBalance(address);
}

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
  const reduceMotion = useReducedMotion();

  const [status, setStatus] = useState<CheckInStatus | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  const [justClaimed, setJustClaimed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Drop negado/esgotado: não reoferecer o botão nesta sessão
  const [gasDropUnavailable, setGasDropUnavailable] = useState(false);
  // Evita null-check de window no render (SSR): só true pós-mount fora do MiniPay
  const [isDesktopEnv, setIsDesktopEnv] = useState(false);

  const confetti = useMemo(() => makeConfetti(20), []);
  const accessToken = session?.access_token ?? null;

  useEffect(() => {
    setIsDesktopEnv(!isMiniPayEnv());
  }, []);

  const authedFetch = useCallback(
    (url: string, init?: RequestInit) =>
      fetchWithAuthRetry(url, init ?? { method: "GET" }, accessToken ?? ""),
    [accessToken]
  );

  useEffect(() => {
    if (!isDesktopEnv || !isAuthenticated || !accessToken) return;
    let cancelled = false;
    authedFetch("/api/celo/check-in/status", { method: "GET" })
      .then(async (res) => {
        if (!res.ok) return null; // 404 = feature off
        return (await res.json()) as CheckInStatus;
      })
      .then((data) => {
        if (!cancelled && data?.enabled) setStatus(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isDesktopEnv, isAuthenticated, accessToken, authedFetch]);

  // Saldo de gas da wallet conectada — decide "Check in" vs "Get gas".
  useEffect(() => {
    if (!isDesktopEnv || !account) {
      setBalanceWei(null);
      return;
    }
    let cancelled = false;
    fetchCeloBalance(account.address)
      .then((balance) => {
        if (!cancelled) setBalanceWei(balance);
      })
      .catch(() => {
        // RPC falhou: assume que tem gas — pior caso a wallet mostra
        // "saldo insuficiente", melhor que esconder o check-in.
        if (!cancelled) setBalanceWei(GAS_DROP_RECIPIENT_MAX_BALANCE_WEI);
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktopEnv, account]);

  const celebrate = useCallback(() => {
    setCelebrating(true);
    setJustClaimed(true);
    window.setTimeout(() => setCelebrating(false), 1800);
    window.setTimeout(() => setDismissed(true), 2600);
  }, []);

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
    if (busy || !account) return;
    setBusy(true);
    setMessage(null);
    try {
      await requestGasDrop(authedFetch, account.address);
      setMessage("Gas on the way...");
      const balance = await waitForGas(account.address);
      setBalanceWei(balance);
      setMessage(null);
    } catch (error) {
      if (error instanceof GasDropError) {
        if (error.code === "balance_sufficient") {
          // Servidor viu saldo que o card não viu — resincroniza.
          setBalanceWei(GAS_DROP_RECIPIENT_MAX_BALANCE_WEI);
          setMessage(null);
        } else {
          setGasDropUnavailable(true);
          setMessage(error.message);
        }
      } else {
        setMessage("Something went wrong — try again");
      }
    }
    setBusy(false);
  }, [busy, account, authedFetch]);

  const handleCheckIn = useCallback(async () => {
    if (busy || !account) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await performCheckIn(
        authedFetch,
        account.address,
        sendViaThirdweb
      );
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              checkedInToday: true,
              currentStreak: result.streak,
              linkedWallet: account.address,
            }
          : prev
      );
      setMessage(`+${result.goldAwarded} gold!`);
      celebrate();
    } catch (error) {
      if (error instanceof CheckInFlowError) {
        if (error.code === "already_checked_in") {
          setStatus((prev) =>
            prev ? { ...prev, checkedInToday: true } : prev
          );
        }
        setMessage(error.message);
      } else if (/rejected|denied|cancelled/i.test(String(error))) {
        // usuário cancelou na wallet — sem tx, sem drama
        setMessage(null);
      } else {
        setMessage("Something went wrong — try again");
      }
    }
    setBusy(false);
  }, [busy, account, authedFetch, sendViaThirdweb, celebrate]);

  if (!isDesktopEnv || !isAuthenticated || !status) return null;
  if (dismissed) return null;
  if (status.checkedInToday && !justClaimed) return null;

  // Wallet já vinculada ao perfil e outra conectada: pede a certa em vez de
  // deixar o challenge/verify falhar depois da fee.
  const walletMismatch =
    account &&
    status.linkedWallet &&
    account.address.toLowerCase() !== status.linkedWallet.toLowerCase();

  const needsGas =
    !gasDropUnavailable &&
    balanceWei !== null &&
    balanceWei < GAS_DROP_RECIPIENT_MAX_BALANCE_WEI;

  const subtitle = status.checkedInToday
    ? `✓ Day ${status.currentStreak} complete`
    : walletMismatch
      ? `Connect ${shortAddress(status.linkedWallet!)}`
      : needsGas
        ? "Free gas for your first check-in"
        : `Streak ${status.currentStreak} → +${status.nextReward} gold`;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9000] w-[min(92vw,340px)] rounded-lg border-2 border-amber-400/60 bg-[#0f0c06]/95 px-4 py-3 shadow-[0_4px_20px_rgba(251,191,36,0.25)] backdrop-blur-sm">
      {celebrating && !reduceMotion && (
        <div className="pointer-events-none absolute inset-x-0 bottom-full h-[260px] overflow-visible" aria-hidden>
          {confetti.map((c) => (
            <motion.div
              key={c.id}
              initial={{ x: 0, y: 0, opacity: 0, rotate: 0 }}
              animate={{
                x: c.xDrift,
                y: c.yRise,
                opacity: [0, 1, 1, 0],
                rotate: c.rotateEnd,
              }}
              transition={{
                duration: 1.4,
                delay: c.delay,
                times: [0, 0.1, 0.7, 1],
                ease: "easeOut",
              }}
              style={{
                position: "absolute",
                left: "50%",
                bottom: 0,
                width: c.size,
                height: c.size * 2,
                background: c.color,
                boxShadow: `0 0 ${c.size}px ${c.color}55`,
              }}
            />
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-pixel text-[10px] uppercase tracking-widest text-amber-300">
            Daily Check-in · Celo
          </p>
          <p className="mt-0.5 text-[11px] text-amber-100/70 truncate">{subtitle}</p>
          {message && (
            <p className="mt-1 text-[11px] text-emerald-300 truncate">{message}</p>
          )}
        </div>
        {!status.checkedInToday &&
          (!account || walletMismatch ? (
            <button
              type="button"
              onClick={handleConnect}
              className="shrink-0 rounded-md border border-amber-400/70 px-3 py-2 font-pixel text-[10px] uppercase tracking-wider text-amber-300 transition-colors hover:bg-amber-400/10"
            >
              Connect
            </button>
          ) : needsGas ? (
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
              className={
                "shrink-0 rounded-md bg-gradient-to-r from-amber-400 to-amber-500 px-3 py-2 font-pixel text-[10px] uppercase tracking-wider text-black transition-opacity " +
                (busy ? "opacity-60 cursor-not-allowed" : "hover:opacity-90")
              }
            >
              {busy ? "..." : "Check in"}
            </button>
          ))}
      </div>
    </div>
  );
}
