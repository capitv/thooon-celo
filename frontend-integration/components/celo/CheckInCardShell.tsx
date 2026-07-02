"use client";

import { useMemo, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

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
 * Chrome compartilhado dos cards de check-in Celo (MiniPay e desktop):
 * container flutuante, confete de celebração, título/subtítulo/mensagem.
 * Toda a lógica de wallet/fluxo fica nos cards — aqui só apresentação,
 * para os dois nunca divergirem visualmente.
 */
export default function CheckInCardShell(props: {
  title: string;
  subtitle: string;
  message: string | null;
  celebrating: boolean;
  /** Slot do botão de ação (ou null quando não há ação disponível). */
  action: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const confetti = useMemo(() => makeConfetti(20), []);

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9000] w-[min(92vw,340px)] rounded-lg border-2 border-amber-400/60 bg-[#0f0c06]/95 px-4 py-3 shadow-[0_4px_20px_rgba(251,191,36,0.25)] backdrop-blur-sm">
      {props.celebrating && !reduceMotion && (
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
            {props.title}
          </p>
          <p className="mt-0.5 text-[11px] text-amber-100/70 truncate">
            {props.subtitle}
          </p>
          {props.message && (
            <p className="mt-1 text-[11px] text-emerald-300 truncate">
              {props.message}
            </p>
          )}
        </div>
        {props.action}
      </div>
    </div>
  );
}
