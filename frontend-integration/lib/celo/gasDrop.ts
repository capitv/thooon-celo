import "server-only";
import { getRpcClient, eth_getBalance } from "thirdweb/rpc";
import { prepareTransaction, sendTransaction } from "thirdweb";
import { privateKeyToAccount, type Account } from "thirdweb/wallets";
import { thirdwebClient } from "@/lib/thirdweb";
import { celo } from "@/lib/thirdweb/chains";
import {
  GAS_DROP_AMOUNT_WEI,
  GAS_DROP_RECIPIENT_MAX_BALANCE_WEI,
} from "@/lib/celo/gasDropConfig";

/**
 * Gas drop: envia 0.02 CELO da hot wallet para a wallet recém-vinculada de
 * um jogador elegível, para que ele pague o próprio gas do check-in.
 *
 * Por que faucet e não relayer/meta-tx: o ThooonCheckIn registra msg.sender.
 * Se o servidor enviasse a tx, TODA a atividade on-chain viria de uma única
 * wallet — jogador precisa ser o sender. O drop preserva isso.
 *
 * Segurança da hot wallet: chave própria (CELO_GAS_DROP_PRIVATE_KEY, nunca
 * a deployer), float pequeno (10-20 CELO), cap diário na rota. Vazou a
 * chave → perda limitada ao float.
 */

const HOT_WALLET_ENV = "CELO_GAS_DROP_PRIVATE_KEY";

/** Margem de gas da própria tx de drop ao checar o saldo da hot wallet
 *  (21k gas a ~400 gwei ≈ 0.0084 CELO; 0.02 dá folga 2x). */
const HOT_WALLET_GAS_MARGIN_WEI = 20_000_000_000_000_000n; // 0.02 CELO

export function isGasDropConfigured(): boolean {
  return (
    process.env.FEATURE_CELO_GAS_DROP === "true" &&
    Boolean(process.env[HOT_WALLET_ENV])
  );
}

/** Conta da hot wallet — null quando a feature está desligada/sem chave. */
export function getGasDropAccount(): Account | null {
  const privateKey = process.env[HOT_WALLET_ENV];
  if (!privateKey) return null;
  return privateKeyToAccount({
    client: thirdwebClient,
    privateKey,
  });
}

export async function getCeloBalanceWei(address: string): Promise<bigint> {
  const rpc = getRpcClient({ client: thirdwebClient, chain: celo });
  return eth_getBalance(rpc, { address: address as `0x${string}` });
}

/** Wallet do jogador já tem gas suficiente? (não desperdiçar o float) */
export async function recipientHasEnoughGas(address: string): Promise<boolean> {
  const balance = await getCeloBalanceWei(address);
  return balance >= GAS_DROP_RECIPIENT_MAX_BALANCE_WEI;
}

/** Hot wallet consegue pagar este drop + gas da própria tx? */
export async function hotWalletCanFund(account: Account): Promise<boolean> {
  const balance = await getCeloBalanceWei(account.address);
  return balance >= GAS_DROP_AMOUNT_WEI + HOT_WALLET_GAS_MARGIN_WEI;
}

/**
 * Envia o drop. Chamar SOMENTE depois da reserva em celo_gas_drops — a
 * unicidade por perfil/wallet vive no banco, não aqui.
 */
export async function sendGasDrop(
  account: Account,
  to: string
): Promise<`0x${string}`> {
  const transaction = prepareTransaction({
    client: thirdwebClient,
    chain: celo,
    to: to as `0x${string}`,
    value: GAS_DROP_AMOUNT_WEI,
  });
  const { transactionHash } = await sendTransaction({ transaction, account });
  return transactionHash;
}
