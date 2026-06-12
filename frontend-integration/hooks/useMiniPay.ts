"use client";

import { useEffect, useState } from "react";
import { isMiniPayEnv, getMiniPayAddress } from "@/lib/minipay";

/**
 * Detecção do MiniPay + auto-connect.
 *
 * SSR-safe: começa com isMiniPay=false (igual ao server render) e só vira
 * true num useEffect pós-mount — sem hydration mismatch. Dentro do MiniPay
 * o eth_requestAccounts é auto-aprovado, então o address chega sem UI.
 */
export function useMiniPay(): {
  isMiniPay: boolean;
  address: string | null;
  isConnecting: boolean;
} {
  const [isMiniPay, setIsMiniPay] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  useEffect(() => {
    if (!isMiniPayEnv()) return;
    setIsMiniPay(true);
    setIsConnecting(true);

    let cancelled = false;
    getMiniPayAddress()
      .then((addr) => {
        if (!cancelled) setAddress(addr);
      })
      .finally(() => {
        if (!cancelled) setIsConnecting(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { isMiniPay, address, isConnecting };
}
