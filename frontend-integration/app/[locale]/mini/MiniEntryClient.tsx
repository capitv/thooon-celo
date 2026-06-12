"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isMiniPayEnv, getMiniPayAddress } from "@/lib/minipay";
import { routes } from "@/lib/routes";

/**
 * Detecta MiniPay pós-mount e redireciona:
 *  - dentro do MiniPay → hub do jogo (auto-connect já disparado)
 *  - browser normal    → home
 *
 * Importa apenas lib/minipay (request cru) — nada de thirdweb aqui, pra
 * manter o bundle da rota de submissão mínimo (<2MB exigidos pelo MiniPay).
 */
export default function MiniEntryClient({ locale }: { locale: string }) {
  const router = useRouter();

  useEffect(() => {
    if (isMiniPayEnv()) {
      // Dispara o auto-connect cedo; não bloqueia o redirect.
      void getMiniPayAddress();
      router.replace(routes.onboardHub(locale));
    } else {
      router.replace(routes.home(locale));
    }
  }, [router, locale]);

  return (
    <main className="min-h-screen bg-[#030713] flex items-center justify-center">
      <div className="text-center">
        <p className="font-pixel text-amber-200 text-sm tracking-[0.25em] uppercase">
          Thooon
        </p>
        <p className="mt-3 text-xs text-neutral-400">Loading…</p>
      </div>
    </main>
  );
}
