/**
 * @jest-environment node
 *
 * Cobertura criptográfica REAL de verifyLoginSignature: assina o payload
 * EIP-712 com uma chave efêmera (viem) e verifica recuperação — sem mocks.
 * Garante que o payload do servidor bate com o que o cliente
 * (signLoginTypedData em lib/minipay.ts) assina.
 */
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  verifyLoginSignature,
  LOGIN_TYPED_DATA_DOMAIN,
  LOGIN_TYPED_DATA_TYPES,
} from "../auth";

const NONCE = `0x${"a".repeat(64)}`;
const ISSUED_AT = "2026-06-11T00:00:00.000Z";

async function signAs(account: ReturnType<typeof privateKeyToAccount>) {
  // Mesmo shape que o cliente manda pro provider via eth_signTypedData_v4.
  return account.signTypedData({
    domain: LOGIN_TYPED_DATA_DOMAIN,
    types: LOGIN_TYPED_DATA_TYPES,
    primaryType: "Login",
    message: {
      wallet: account.address,
      nonce: NONCE,
      issuedAt: ISSUED_AT,
    },
  });
}

describe("verifyLoginSignature", () => {
  const account = privateKeyToAccount(generatePrivateKey());

  it("aceita assinatura da própria wallet", async () => {
    const signature = await signAs(account);
    await expect(
      verifyLoginSignature({
        walletAddress: account.address,
        nonce: NONCE,
        issuedAt: ISSUED_AT,
        signature,
      })
    ).resolves.toBe(true);
  });

  it("aceita com wallet em lowercase (normalização de address)", async () => {
    const signature = await signAs(account);
    await expect(
      verifyLoginSignature({
        walletAddress: account.address.toLowerCase(),
        nonce: NONCE,
        issuedAt: ISSUED_AT,
        signature,
      })
    ).resolves.toBe(true);
  });

  it("rejeita assinatura de OUTRA wallet (claim de wallet alheia)", async () => {
    const attacker = privateKeyToAccount(generatePrivateKey());
    const signature = await signAs(attacker);
    await expect(
      verifyLoginSignature({
        walletAddress: account.address,
        nonce: NONCE,
        issuedAt: ISSUED_AT,
        signature,
      })
    ).resolves.toBe(false);
  });

  it("rejeita quando o nonce difere do assinado", async () => {
    const signature = await signAs(account);
    await expect(
      verifyLoginSignature({
        walletAddress: account.address,
        nonce: `0x${"b".repeat(64)}`,
        issuedAt: ISSUED_AT,
        signature,
      })
    ).resolves.toBe(false);
  });

  it("rejeita quando o issuedAt difere do assinado", async () => {
    const signature = await signAs(account);
    await expect(
      verifyLoginSignature({
        walletAddress: account.address,
        nonce: NONCE,
        issuedAt: "2026-06-12T00:00:00.000Z",
        signature,
      })
    ).resolves.toBe(false);
  });

  it("rejeita lixo como assinatura sem lançar", async () => {
    await expect(
      verifyLoginSignature({
        walletAddress: account.address,
        nonce: NONCE,
        issuedAt: ISSUED_AT,
        signature: `0x${"00".repeat(65)}`,
      })
    ).resolves.toBe(false);
  });
});
