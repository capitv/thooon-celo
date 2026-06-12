import { defineChain } from "thirdweb/chains";

/**
 * Berachain Mainnet
 * Official Berachain network configuration
 * Chain ID: 80094
 */
export const berachain = defineChain({
  id: 80094,
  name: "Berachain",
  nativeCurrency: {
    name: "BERA",
    symbol: "BERA",
    decimals: 18,
  },
  rpc: process.env.NEXT_PUBLIC_BERACHAIN_RPC_URL || "https://rpc.berachain-apis.com",
});

/**
 * Celo Mainnet (L2, OP Stack)
 * Chain ID: 42220 — usado pelo check-in diário on-chain (Proof of Ship / MiniPay)
 */
export const celo = defineChain({
  id: 42220,
  name: "Celo",
  nativeCurrency: {
    name: "CELO",
    symbol: "CELO",
    decimals: 18,
  },
  rpc: process.env.CELO_RPC_URL || "https://forno.celo.org",
});

/**
 * Berachain Artio Testnet (legacy)
 * Use apenas para testes
 */
export const berachainTestnet = defineChain({
  id: 80084,
  name: "Berachain Artio",
  nativeCurrency: {
    name: "BERA",
    symbol: "BERA",
    decimals: 18,
  },
  rpc: "https://artio.rpc.berachain.com",
});
