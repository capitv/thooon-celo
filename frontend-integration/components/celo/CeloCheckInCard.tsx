"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { useMiniPay } from "@/hooks/useMiniPay";
import { fetchWithAuthRetry } from "@/lib/auth/fetchWithAuthRetry";
import CheckInCardShell from "@/components/celo/CheckInCardShell";
import type { CheckInStatusResponse } from "@/lib/celo/checkinFlow";

/**
 * FALLBACK SIMULADO (remover quando o -32604 for resolvido):
 * o MiniPay nega eth_sendTransaction para contratos sem popup (-32604),
 * então a tx de check-in nunca sai do device. Para não travar a UX num
 * erro sem saída, tx cancelada/negada vira sucesso VISUAL — sem gold,
 * sem registro on-chain, sem vínculo de wallet. Persistido por dia (UTC,
 * mesmo day do contrato) em localStorage para o card não reabrir.
 */
const SIMULATED_KEY_PREFIX = "celo-checkin:simulated:";

// Escopado por wallet: outra conta no mesmo device não herda o check-in
function utcDayKey(address: string): string {
  return `${SIMULATED_KEY_PREFIX}${address.toLowerCase()}:${new Date().toISOString().slice(0, 10)}`;
}

function hasSimulatedCheckInToday(address: string): boolean {
  try {
    return localStorage.getItem(utcDayKey(address)) === "1";
  } catch {
    return false;
  }
}

function markSimulatedCheckInToday(address: string): void {
  try {
    localStorage.setItem(utcDayKey(address), "1");
  } catch {
    // localStorage bloqueado — só não persiste entre reloads
  }
}

/**
 * Card flutuante de check-in diário on-chain (Celo) — só aparece dentro do
 * MiniPay com a feature ligada. A tx de check-in também vincula a wallet ao
 * perfil (substitui o SIWE, que o MiniPay não suporta).
 *
 * Auto-contido: busca o próprio status e some em qualquer estado não
 * elegível, então pode ser montado em qualquer página sem efeitos.
 * Chrome visual compartilhado com o card desktop via CheckInCardShell.
 */
export default function CeloCheckInCard() {
  const { isMiniPay, address } = useMiniPay();
  const { isAuthenticated, session, celoCheckIn } = useAuth();
  const [status, setStatus] = useState<CheckInStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  // Card some após o claim (delay pro confete) e nem aparece se já fez hoje
  const [justClaimed, setJustClaimed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const accessToken = session?.access_token ?? null;

  useEffect(() => {
    if (!isMiniPay || !isAuthenticated || !accessToken || !address) return;
    let cancelled = false;
    fetchWithAuthRetry("/api/celo/check-in/status", { method: "GET" }, accessToken)
      .then(async (res) => {
        if (!res.ok) return null; // 404 = feature off
        return (await res.json()) as CheckInStatusResponse;
      })
      .then((data) => {
        if (cancelled || !data?.enabled) return;
        // Check-in simulado de hoje sobrepõe o status do servidor
        if (!data.checkedInToday && hasSimulatedCheckInToday(address)) {
          setStatus({ ...data, checkedInToday: true });
        } else {
          setStatus(data);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isMiniPay, isAuthenticated, accessToken, address]);

  const celebrate = useCallback(() => {
    setCelebrating(true);
    setJustClaimed(true);
    window.setTimeout(() => setCelebrating(false), 1800);
    window.setTimeout(() => setDismissed(true), 2600);
  }, []);

  const handleCheckIn = useCallback(async () => {
    if (busy || !address) return;
    setBusy(true);
    setMessage(null);
    const { error, result } = await celoCheckIn(address);
    if (error) {
      if (/cancelled|denied|rejected/i.test(error.message)) {
        // Tx negada pelo MiniPay (-32604) ou cancelada — fallback simulado
        markSimulatedCheckInToday(address);
        setStatus((prev) => (prev ? { ...prev, checkedInToday: true } : prev));
        setMessage("✓ Checked in!");
        celebrate();
      } else {
        setMessage(error.message);
      }
    } else if (result) {
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              checkedInToday: true,
              currentStreak: result.streak,
              linkedWallet: address,
            }
          : prev
      );
      setMessage(`+${result.goldAwarded} gold!`);
      celebrate();
    }
    setBusy(false);
  }, [busy, address, celoCheckIn, celebrate]);

  if (!isMiniPay || !isAuthenticated || !status || !address) return null;
  if (dismissed) return null;
  // Já fez check-in hoje (e não foi agora nesta sessão): não mostra nada
  if (status.checkedInToday && !justClaimed) return null;

  return (
    <CheckInCardShell
      title="Daily Check-in"
      subtitle={
        status.checkedInToday
          ? `✓ Day ${status.currentStreak} complete`
          : `Streak ${status.currentStreak} → +${status.nextReward} gold`
      }
      message={message}
      celebrating={celebrating}
      action={
        status.checkedInToday ? null : (
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
        )
      }
    />
  );
}
