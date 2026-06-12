import type { Metadata } from "next";
import MiniEntryClient from "./MiniEntryClient";

export const metadata: Metadata = {
  title: "Thooon on MiniPay — Play & Earn",
  description:
    "Play Thooon inside MiniPay: battles, expeditions and a daily on-chain check-in on Celo. Free to play, network fees paid in stablecoins.",
  robots: { index: true, follow: true },
};

/**
 * Entrada dedicada para o MiniPay (URL de submissão: thooon.com/mini).
 * Página de servidor mínima — zero thirdweb, zero mídia pesada — que detecta
 * o ambiente no cliente e redireciona para o hub do jogo.
 */
export default function MiniPage({
  params,
}: {
  params: { locale: string };
}) {
  return <MiniEntryClient locale={params.locale} />;
}
