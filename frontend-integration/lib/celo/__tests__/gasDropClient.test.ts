/**
 * Testes do cliente do gas drop — fetch mockado, códigos estáveis.
 */

import { requestGasDrop, GasDropError } from "../gasDropClient";

const WALLET = "0xabcd000000000000000000000000000000000001";
const TX_HASH =
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("requestGasDrop", () => {
  it("retorna txHash no sucesso", async () => {
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        txHash: TX_HASH,
        amountWei: "20000000000000000",
      })
    );

    const result = await requestGasDrop(fetcher, WALLET);

    expect(result.txHash).toBe(TX_HASH);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/celo/gas-drop",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ walletAddress: WALLET }),
      })
    );
  });

  it.each([
    [403, "not_eligible"],
    [409, "already_received"],
    [400, "balance_sufficient"],
    [429, "daily_cap"],
  ] as const)("propaga código %s do servidor", async (status, code) => {
    const fetcher = jest
      .fn()
      .mockResolvedValue(jsonResponse(status, { error: "nope", code }));

    await expect(requestGasDrop(fetcher, WALLET)).rejects.toMatchObject({
      name: "GasDropError",
      code,
    });
  });

  it("erro sem código conhecido vira drop_failed", async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValue(jsonResponse(500, { error: "boom" }));

    await expect(requestGasDrop(fetcher, WALLET)).rejects.toMatchObject({
      code: "drop_failed",
    });
  });

  it("body não-JSON no erro também vira drop_failed", async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    await expect(requestGasDrop(fetcher, WALLET)).rejects.toBeInstanceOf(
      GasDropError
    );
  });
});
