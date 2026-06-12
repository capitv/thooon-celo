// NÃO usar features.minipay (lib/env) aqui: no bundle de CLIENTE o Next.js
// só substitui referências DIRETAS a process.env.NEXT_PUBLIC_* — o spread
// `{...process.env}` do env.ts fica vazio no browser e a flag avaliaria
// false pra sempre. Referência direta = inline em build time.
const MINIPAY_FEATURE_ENABLED =
  process.env.NEXT_PUBLIC_FEATURE_MINIPAY === "true";

/**
 * Detecção e helpers do MiniPay (wallet Celo da Opera, webview Android/iOS).
 *
 * Constraints do ambiente MiniPay que este módulo assume (validadas em
 * device físico, 11/jun/2026 — a doc oficial estava desatualizada):
 *  - provider injetado em window.ethereum com isMiniPay === true
 *  - assinatura FUNCIONA: personal_sign e eth_signTypedData_v3/v4 mostram
 *    popup de aprovação → login usa EIP-712 (signLoginTypedData)
 *  - eth_sendTransaction para CONTRATOS é negado com -32604 "Permission
 *    denied" SEM popup (self-transfer com data mostra popup; estimateGas
 *    do mesmo call passa) — por isso a tx de check-in não é mais o método
 *    primário de login
 *  - transações legacy apenas (sem campos EIP-1559)
 *  - auto-connect: NÃO mostrar botão "Connect Wallet" dentro do MiniPay
 */

// USDm (cUSD) na Celo Mainnet — usado como feeCurrency (token de 18 decimais,
// o próprio endereço do token serve de feeCurrency, diferente de USDC/USDT
// que usam adapters).
export const CELO_USDM_ADDRESS = "0x765DE816845861e75A25fCA122bb6898B8B1282a";

type InjectedProvider = {
  isMiniPay?: boolean;
  request: (args: {
    method: string;
    params?: unknown[];
  }) => Promise<unknown>;
};

function getInjectedProvider(): InjectedProvider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as { ethereum?: InjectedProvider }).ethereum;
  return eth ?? null;
}

/** True somente dentro do webview do MiniPay E com a feature flag ligada. */
export function isMiniPayEnv(): boolean {
  if (!MINIPAY_FEATURE_ENABLED) return false;
  const eth = getInjectedProvider();
  return eth?.isMiniPay === true;
}

/**
 * Endereço da wallet MiniPay via eth_requestAccounts (auto-aprovado dentro
 * do MiniPay). Retorna null fora do MiniPay ou se o usuário recusar.
 */
export async function getMiniPayAddress(): Promise<string | null> {
  if (!isMiniPayEnv()) return null;
  const eth = getInjectedProvider();
  if (!eth) return null;
  try {
    const accounts = (await eth.request({
      method: "eth_requestAccounts",
    })) as string[] | undefined;
    return accounts?.[0]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * Conta EXATAMENTE como o provider reporta (sem normalizar case). O MiniPay
 * rejeita eth_sendTransaction com -32604 "Permission denied" quando o `from`
 * não bate byte a byte com a conta conectada — endereço lowercased conta
 * como "outra conta".
 */
async function getRawProviderAccount(eth: InjectedProvider): Promise<string> {
  const accounts = (await eth.request({
    method: "eth_requestAccounts",
  })) as string[] | undefined;
  const account = accounts?.[0];
  if (!account) throw new Error("No connected wallet account");
  return account;
}

/**
 * Assina o payload EIP-712 de login. Espelho EXATO de
 * LOGIN_TYPED_DATA_DOMAIN/TYPES em src/lib/celo/auth.ts — qualquer
 * divergência muda o digest e o verify recusa. Duplicado aqui de propósito:
 * importar lib/celo/auth (thirdweb/rpc) explodiria o bundle de cliente.
 *
 * Tenta eth_signTypedData_v4; cai para v3 SÓ em -32601 (método inexistente
 * em builds antigos) — nunca em rejeição do usuário, senão o popup
 * reapareceria depois de um "cancelar".
 */
export async function signLoginTypedData(params: {
  nonce: string; // 0x + 64 hex
  issuedAt: string; // ISO, ecoado do challenge
  from: string; // sanity-check; a conta real vem do provider
}): Promise<`0x${string}`> {
  const eth = getInjectedProvider();
  if (!eth) throw new Error("No injected wallet provider");

  const account = await getRawProviderAccount(eth);
  if (account.toLowerCase() !== params.from.toLowerCase()) {
    throw new Error("Connected wallet changed. Please try again.");
  }

  const payload = JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      Login: [
        { name: "wallet", type: "address" },
        { name: "nonce", type: "string" },
        { name: "issuedAt", type: "string" },
      ],
    },
    primaryType: "Login",
    domain: { name: "Thooon Sign-In", version: "1", chainId: 42220 },
    message: {
      wallet: account,
      nonce: params.nonce,
      issuedAt: params.issuedAt,
    },
  });

  try {
    return (await eth.request({
      method: "eth_signTypedData_v4",
      params: [account, payload],
    })) as `0x${string}`;
  } catch (err) {
    const code = (err as { code?: number } | null)?.code;
    if (code === -32601) {
      return (await eth.request({
        method: "eth_signTypedData_v3",
        params: [account, payload],
      })) as `0x${string}`;
    }
    throw err;
  }
}

/**
 * Envia a tx de check-in `checkIn(bytes32 nonce)` pelo provider injetado.
 * Tx legacy (sem EIP-1559). `feeCurrency` NÃO é setado: o MiniPay escolhe a
 * stablecoin da fee sozinho (doc atual: "MiniPay may ignore feeCurrency and
 * choose the token the user has the most of").
 *
 * Usa request() cru em vez do SDK thirdweb: é o caminho recomendado pela
 * doc do MiniPay e evita campos de tx que o webview ignora/rejeita.
 */
export async function sendCheckInTransaction(params: {
  contractAddress: string;
  nonce: string; // 0x + 64 hex
  from: string; // usado só para sanity-check; o from real vem do provider
}): Promise<`0x${string}`> {
  const eth = getInjectedProvider();
  if (!eth) throw new Error("No injected wallet provider");

  const account = await getRawProviderAccount(eth);
  if (account.toLowerCase() !== params.from.toLowerCase()) {
    throw new Error("Connected wallet changed. Please try again.");
  }

  // checkIn(bytes32) selector — `cast sig "checkIn(bytes32)"` = 0x4662d1dd.
  // Fixado para não depender de lib de ABI no client bundle.
  const CHECKIN_SELECTOR = "0x4662d1dd";
  const noncePadded = params.nonce.replace(/^0x/, "").padStart(64, "0");
  const data = `${CHECKIN_SELECTOR}${noncePadded}`;

  const txHash = (await eth.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: account,
        to: params.contractAddress,
        data,
      },
    ],
  })) as `0x${string}`;

  return txHash;
}

/**
 * Tx de prova de posse SEM contrato: valor 0 da wallet pra ela mesma com o
 * nonce no calldata. Usada pelo "Sign in with MiniPay" quando o check-in de
 * hoje já foi feito (checkIn reverteria com AlreadyCheckedInToday).
 */
export async function sendSelfProofTransaction(params: {
  nonce: string; // 0x + 64 hex
  from: string; // sanity-check; o from real vem do provider
}): Promise<`0x${string}`> {
  const eth = getInjectedProvider();
  if (!eth) throw new Error("No injected wallet provider");

  const account = await getRawProviderAccount(eth);
  if (account.toLowerCase() !== params.from.toLowerCase()) {
    throw new Error("Connected wallet changed. Please try again.");
  }

  const txHash = (await eth.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: account,
        to: account,
        value: "0x0",
        data: params.nonce,
      },
    ],
  })) as `0x${string}`;

  return txHash;
}
