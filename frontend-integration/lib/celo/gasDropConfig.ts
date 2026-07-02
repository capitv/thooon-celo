/**
 * Constantes do gas drop (faucet de CELO para o check-in desktop).
 *
 * Isomórfico DE PROPÓSITO: o card (client) usa o threshold para decidir
 * quando oferecer o botão "Get gas", o server usa os mesmos números para
 * decidir quando negar. Nada de segredo aqui — a chave da hot wallet vive
 * só em lib/celo/gasDrop.ts (server-only).
 *
 * Números calibrados por medição em produção (2026-07-02): check-in real
 * custou 0.0276 CELO a 402 gwei (estimativa inflada do thirdweb) e o
 * eth_gasPrice da Celo estava em ~200 gwei — fee justa de um check-in
 * (~68.5k gas) ≈ 0.014 CELO. Não assumir os 25 gwei históricos da doc.
 *
 * No port: considerar mover para ECONOMY_LIMITS (economy-guardrails) junto
 * dos números do check-in.
 */

/** 0.2 CELO — ~14 check-ins a ~0.014 CELO/tx (fee medida, não a teórica). */
export const GAS_DROP_AMOUNT_WEI = 200_000_000_000_000_000n;

/**
 * 0.02 CELO — abaixo disto a wallet não paga nem 1-2 check-ins, então
 * recebe (não recebeu) drop. Também é o threshold do card para trocar
 * "Check in" por "Get gas".
 */
export const GAS_DROP_RECIPIENT_MAX_BALANCE_WEI = 20_000_000_000_000_000n;

/** Teto de drops por dia UTC (circuit breaker — sybil que passou dos outros filtros). */
export const GAS_DROP_DAILY_CAP = 50;

/**
 * Idade mínima da conta. Anti-sybil principal: dragar o faucet exige jogar
 * Thooon de verdade por dias — para ganhar centavos. No port, endurecer com
 * progresso de jogo real (tutorial/nível) além da idade.
 */
export const GAS_DROP_MIN_ACCOUNT_AGE_DAYS = 3;
