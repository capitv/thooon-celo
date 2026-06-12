import {
  getRpcClient,
  eth_getTransactionReceipt,
  eth_blockNumber,
  eth_call,
  eth_getTransactionByHash,
} from 'thirdweb/rpc';
import { recoverTypedDataAddress } from 'viem';
import { thirdwebClient } from '@/lib/thirdweb';
import { celo } from '@/lib/thirdweb/chains';
import { normalizeAddress } from '@/lib/utils';
import { getCheckInContractAddress } from '@/lib/celo/checkin';

/**
 * "Sign in with MiniPay" — autenticação por prova de posse da chave.
 *
 * Método principal: "signature" — EIP-712 via eth_signTypedData_v4/v3.
 * (A doc do MiniPay dizia que assinatura não era suportada; teste em device
 * físico em 11/jun/2026 mostrou popup funcionando para personal_sign e
 * signTypedData v3/v4. eth_sendTransaction para contratos é que é negado
 * com -32604 sem popup.)
 *
 * Métodos legados por transação (mantidos para verify de txs já enviadas):
 *  - "checkIn": tx no contrato ThooonCheckIn (login + check-in diário
 *    + gold numa tx só)
 *  - "selfProof": tx de valor 0 da wallet para ela mesma com o nonce
 *    no calldata
 */

export const CELO_AUTH_NONCE_TTL_SECONDS = 30 * 60;
export const CELO_AUTH_NONCE_PREFIX = 'celo-auth:nonce:';

// hasCheckedInToday(address) — `cast sig "hasCheckedInToday(address)"`
const HAS_CHECKED_IN_TODAY_SELECTOR = '0x3504f52b';

const MIN_CONFIRMATIONS = 2n;

export type CeloAuthMethod = 'checkIn' | 'selfProof' | 'signature';

export interface CeloAuthChallenge {
  nonce: string;
  walletAddress: string;
  method: CeloAuthMethod;
  issuedAt: string;
}

export function getCeloAuthNonceKey(nonce: string): string {
  return `${CELO_AUTH_NONCE_PREFIX}${nonce}`;
}

/** Consulta on-chain: a wallet já fez check-in hoje? (decide o método) */
export async function hasCheckedInTodayOnChain(
  walletAddress: string
): Promise<boolean> {
  const contractAddress = getCheckInContractAddress();
  if (!contractAddress) {
    throw new Error('Celo check-in contract address not configured');
  }
  const rpc = getRpcClient({ client: thirdwebClient, chain: celo });
  const padded = normalizeAddress(walletAddress)
    .replace(/^0x/, '')
    .padStart(64, '0');
  const result = await eth_call(rpc, {
    to: contractAddress as `0x${string}`,
    data: `${HAS_CHECKED_IN_TODAY_SELECTOR}${padded}` as `0x${string}`,
  });
  return BigInt(result) === 1n;
}

export type SelfProofVerification =
  | { status: 'pending' }
  | { status: 'failed' }
  | { status: 'confirmed'; account: string };

/**
 * Verifica a tx de self-proof: from == wallet declarada, to == from,
 * calldata == nonce, sucesso, ≥2 confirmações. Tudo lido do RPC.
 */
export async function verifySelfProofTx(
  txHash: `0x${string}`,
  expected: { walletAddress: string; nonce: string }
): Promise<SelfProofVerification> {
  const rpc = getRpcClient({ client: thirdwebClient, chain: celo });

  let receipt;
  try {
    receipt = await eth_getTransactionReceipt(rpc, { hash: txHash });
  } catch {
    return { status: 'pending' };
  }
  if (!receipt) return { status: 'pending' };
  if (receipt.status !== 'success') return { status: 'failed' };

  const head = await eth_blockNumber(rpc);
  if (head - receipt.blockNumber < MIN_CONFIRMATIONS) {
    return { status: 'pending' };
  }

  const tx = await eth_getTransactionByHash(rpc, { hash: txHash });
  if (!tx) return { status: 'pending' };

  const from = normalizeAddress(tx.from);
  const to = tx.to ? normalizeAddress(tx.to) : null;
  const input = (tx.input ?? '0x').toLowerCase();
  const wallet = normalizeAddress(expected.walletAddress);

  if (from !== wallet || to !== wallet) return { status: 'failed' };
  if (input !== expected.nonce.toLowerCase()) return { status: 'failed' };

  return { status: 'confirmed', account: from };
}

/**
 * EIP-712 do login por assinatura. O cliente (lib/minipay.ts) monta o MESMO
 * payload — qualquer divergência de campo/ordem muda o digest e a
 * verificação falha. chainId fixo em Celo Mainnet: assinatura de outra
 * chain não vale aqui.
 */
export const LOGIN_TYPED_DATA_DOMAIN = {
  name: 'Thooon Sign-In',
  version: '1',
  chainId: 42220,
} as const;

export const LOGIN_TYPED_DATA_TYPES = {
  Login: [
    { name: 'wallet', type: 'address' },
    { name: 'nonce', type: 'string' },
    { name: 'issuedAt', type: 'string' },
  ],
} as const;

/**
 * Recupera o signatário do payload EIP-712 e compara com a wallet do
 * challenge. MiniPay é sempre EOA — não há caso ERC-1271 aqui.
 */
export async function verifyLoginSignature(params: {
  walletAddress: string;
  nonce: string;
  issuedAt: string;
  signature: `0x${string}`;
}): Promise<boolean> {
  try {
    const recovered = await recoverTypedDataAddress({
      domain: LOGIN_TYPED_DATA_DOMAIN,
      types: LOGIN_TYPED_DATA_TYPES,
      primaryType: 'Login',
      message: {
        wallet: normalizeAddress(params.walletAddress) as `0x${string}`,
        nonce: params.nonce,
        issuedAt: params.issuedAt,
      },
      signature: params.signature,
    });
    return (
      normalizeAddress(recovered) === normalizeAddress(params.walletAddress)
    );
  } catch {
    return false;
  }
}

const CELO_WALLET_EMAIL_DOMAIN = 'wallet.thooon.com';

/** Email sintético determinístico para contas criadas via wallet MiniPay. */
export function celoWalletEmail(walletAddress: string): string {
  return `celo-${normalizeAddress(walletAddress).replace(/^0x/, '')}@${CELO_WALLET_EMAIL_DOMAIN}`;
}

/**
 * Conta nativa de wallet? (email sintético gerado por celoWalletEmail).
 * Decide se posse da wallet basta pra mintar sessão: contas de email real
 * que apenas VINCULARAM a wallet entram pelo login normal (senha+captcha).
 */
export function isCeloWalletEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${CELO_WALLET_EMAIL_DOMAIN}`);
}

/** Username default legível derivado da wallet. */
export function celoWalletUsername(walletAddress: string): string {
  return `thoon-${normalizeAddress(walletAddress).slice(-6)}`;
}
