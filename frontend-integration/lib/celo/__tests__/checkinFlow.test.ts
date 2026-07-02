/**
 * Testes do fluxo de check-in do cliente (checkinFlow) — fetch mockado.
 * Sem thirdweb aqui: o módulo é wallet-agnóstico por design.
 */

import {
  requestCheckInChallenge,
  verifyCheckInTx,
  performCheckIn,
  CheckInFlowError,
  type CheckInChallenge,
} from "../checkinFlow";

const WALLET = "0xabcd000000000000000000000000000000000001";
const NONCE =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const TX_HASH =
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const noSleep = async () => {};

describe("requestCheckInChallenge", () => {
  it("retorna o challenge no sucesso", async () => {
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        nonce: NONCE,
        contractAddress: "0x1",
        chainId: 42220,
        expiresInSeconds: 1800,
      })
    );

    const challenge = await requestCheckInChallenge(fetcher, WALLET);

    expect(challenge.nonce).toBe(NONCE);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/celo/check-in/challenge",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ walletAddress: WALLET }),
      })
    );
  });

  it.each([
    [429, "already_checked_in"],
    [409, "wallet_conflict"],
    [500, "challenge_failed"],
  ] as const)("status %i vira código %s", async (status, code) => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse(status, {}));

    await expect(requestCheckInChallenge(fetcher, WALLET)).rejects.toMatchObject(
      { name: "CheckInFlowError", code }
    );
  });
});

describe("verifyCheckInTx", () => {
  it("repete em 202 e resolve quando confirma", async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { pending: true, retryAfterMs: 1 }))
      .mockResolvedValueOnce(jsonResponse(202, { pending: true, retryAfterMs: 1 }))
      .mockResolvedValueOnce(
        jsonResponse(200, { streak: 3, goldAwarded: 120, walletLinked: WALLET })
      );

    const result = await verifyCheckInTx(
      fetcher,
      { txHash: TX_HASH, nonce: NONCE },
      noSleep
    );

    expect(result).toEqual({ streak: 3, goldAwarded: 120, walletLinked: WALLET });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("timeout após esgotar as tentativas em 202", async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValue(jsonResponse(202, { pending: true, retryAfterMs: 1 }));

    await expect(
      verifyCheckInTx(fetcher, { txHash: TX_HASH, nonce: NONCE }, noSleep)
    ).rejects.toMatchObject({ code: "verify_timeout" });
  });

  it("409 vira already_checked_in", async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse(409, {}));

    await expect(
      verifyCheckInTx(fetcher, { txHash: TX_HASH, nonce: NONCE }, noSleep)
    ).rejects.toMatchObject({ code: "already_checked_in" });
  });

  it("4xx/5xx genérico vira verify_failed", async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse(400, {}));

    await expect(
      verifyCheckInTx(fetcher, { txHash: TX_HASH, nonce: NONCE }, noSleep)
    ).rejects.toMatchObject({ code: "verify_failed" });
  });
});

describe("performCheckIn", () => {
  it("encadeia challenge → sendTx → verify", async () => {
    const fetcher = jest
      .fn()
      // challenge
      .mockResolvedValueOnce(
        jsonResponse(200, {
          nonce: NONCE,
          contractAddress: "0x1",
          chainId: 42220,
          expiresInSeconds: 1800,
        })
      )
      // verify
      .mockResolvedValueOnce(
        jsonResponse(200, { streak: 1, goldAwarded: 50, walletLinked: WALLET })
      );
    const sendTx = jest.fn(async (challenge: CheckInChallenge) => {
      expect(challenge.nonce).toBe(NONCE);
      return TX_HASH;
    });

    const result = await performCheckIn(fetcher, WALLET, sendTx);

    expect(sendTx).toHaveBeenCalledTimes(1);
    expect(result.goldAwarded).toBe(50);
  });

  it("não chama sendTx se o challenge falha — usuário não paga fee à toa", async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse(429, {}));
    const sendTx = jest.fn();

    await expect(performCheckIn(fetcher, WALLET, sendTx)).rejects.toBeInstanceOf(
      CheckInFlowError
    );
    expect(sendTx).not.toHaveBeenCalled();
  });
});
