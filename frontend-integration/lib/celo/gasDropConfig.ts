/**
 * Constantes do gas drop (faucet de CELO para o check-in desktop).
 *
 * Isomórfico DE PROPÓSITO: o card (client) usa o threshold para decidir
 * quando oferecer o botão "Get gas", o server usa os mesmos números para
 * decidir quando negar. Nada de segredo aqui — a chave da hot wallet vive
 * só em lib/celo/gasDrop.ts (server-only).
 *
 * No port: considerar mover para ECONOMY_LIMITS (economy-guardrails) junto
 * dos números do check-in.
 */

/** 0.02 CELO — cobre ~1 mês de check-ins diários (~50-70k gas/tx na Celo). */
export const GAS_DROP_AMOUNT_WEI = 20_000_000_000_000_000n;

/**
 * 0.005 CELO — wallet com saldo acima disto não precisa (nem recebe) drop.
 * Também é o threshold do card para trocar "Check in" por "Get gas".
 */
export const GAS_DROP_RECIPIENT_MAX_BALANCE_WEI = 5_000_000_000_000_000n;

/** Teto de drops por dia UTC (circuit breaker — sybil que passou dos outros filtros). */
export const GAS_DROP_DAILY_CAP = 50;

/**
 * Idade mínima da conta. Anti-sybil principal: dragar o faucet exige jogar
 * Thooon de verdade por dias — para ganhar ~US$0.01. No port, endurecer com
 * progresso de jogo real (tutorial/nível) além da idade.
 */
export const GAS_DROP_MIN_ACCOUNT_AGE_DAYS = 3;
