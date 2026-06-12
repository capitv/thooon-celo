"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useAuth } from "@/components/providers/AuthProvider";
import { useMiniPay } from "@/hooks/useMiniPay";
import { fetchWithAuthRetry } from "@/lib/auth/fetchWithAuthRetry";

type CheckInStatus = {
  enabled: boolean;
  linkedWallet: string | null;
  checkedInToday: boolean;
  currentStreak: number;
  nextReward: number;
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

/**
 * FALLBACK SIMULADO (remover quando o -32604 for resolvido):
 * o MiniPay nega eth_sendTransaction para contratos sem popup (-32604),
 * então a tx de check-in nunca sai do device. Para não travar a UX num
 * erro sem saída, tx cancelada/negada vira sucesso VISUAL — sem gold,
 * sem registro on-chain, sem vínculo de wallet. Persistido por dia (UTC,
 * mesmo day do contrato) em localStorage para o card não reabrir.
 */
const SIMULATED_KEY_PREFIX = "celo-checkin:simulated:";

function utcDayKey(): string {
  return `${SIMULATED_KEY_PREFIX}${new Date().toISOString().slice(0, 10)}`;
}

function hasSimulatedCheckInToday(): boolean {
  try {
    return localStorage.getItem(utcDayKey()) === "1";
  } catch {
    return false;
  }
}

function markSimulatedCheckInToday(): void {
  try {
    localStorage.setItem(utcDayKey(), "1");
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
 */
export default function CeloCheckInCard() {
  const { isMiniPay, address } = useMiniPay();
  const { isAuthenticated, session, celoCheckIn } = useAuth();
  const reduceMotion = useReducedMotion();
  const [status, setStatus] = useState<CheckInStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  // Card some após o claim (delay pro confete) e nem aparece se já fez hoje
  const [justClaimed, setJustClaimed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const confetti = useMemo(() => makeConfetti(20), []);

  const accessToken = session?.access_token ?? null;

  useEffect(() => {
    if (!isMiniPay || !isAuthenticated || !accessToken) return;
    let cancelled = false;
    fetchWithAuthRetry("/api/celo/check-in/status", { method: "GET" }, accessToken)
      .then(async (res) => {
        if (!res.ok) return null; // 404 = feature off
        return (await res.json()) as CheckInStatus;
      })
      .then((data) => {
        if (cancelled || !data?.enabled) return;
        // Check-in simulado de hoje sobrepõe o status do servidor
        if (!data.checkedInToday && hasSimulatedCheckInToday()) {
          setStatus({ ...data, checkedInToday: true });
        } else {
          setStatus(data);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isMiniPay, isAuthenticated, accessToken]);

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
        markSimulatedCheckInToday();
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
            Daily Check-in
          </p>
          <p className="mt-0.5 text-[11px] text-amber-100/70 truncate">
            {status.checkedInToday
              ? `✓ Day ${status.currentStreak} complete`
              : `Streak ${status.currentStreak} → +${status.nextReward} gold`}
          </p>
          {message && (
            <p className="mt-1 text-[11px] text-emerald-300 truncate">{message}</p>
          )}
        </div>
        {!status.checkedInToday && (
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
        )}
      </div>
    </div>
  );
}
