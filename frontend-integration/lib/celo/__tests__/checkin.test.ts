/**
 * Testes de verifyCheckInTx — RPC da Celo mockado por completo.
 */

const CONTRACT = "0x1111111111111111111111111111111111111111";
const OTHER_CONTRACT = "0x2222222222222222222222222222222222222222";
const ACCOUNT = "0xAbCd000000000000000000000000000000000001";
const NONCE =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TX_HASH =
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;

const mockGetTransactionReceipt = jest.fn();
const mockBlockNumber = jest.fn();
const mockParseEventLogs = jest.fn();

jest.mock("thirdweb/rpc", () => ({
  getRpcClient: jest.fn(() => ({})),
  eth_getTransactionReceipt: (...args: unknown[]) =>
    mockGetTransactionReceipt(...args),
  eth_blockNumber: (...args: unknown[]) => mockBlockNumber(...args),
}));

jest.mock("thirdweb", () => ({
  prepareEvent: jest.fn(() => ({ topics: ["0xevent"] })),
  parseEventLogs: (...args: unknown[]) => mockParseEventLogs(...args),
}));

jest.mock("@/lib/thirdweb", () => ({
  thirdwebClient: {},
}));

describe("verifyCheckInTx", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_CELO_CHECKIN_CONTRACT_ADDRESS = CONTRACT;
  });

  afterAll(() => {
    delete process.env.NEXT_PUBLIC_CELO_CHECKIN_CONTRACT_ADDRESS;
  });

  async function loadModule() {
    return import("../checkin");
  }

  function makeReceipt(overrides: Record<string, unknown> = {}) {
    return {
      status: "success",
      blockNumber: 100n,
      logs: [{ address: CONTRACT, topics: ["0xevent"], data: "0x" }],
      ...overrides,
    };
  }

  function makeEvent(overrides: Record<string, unknown> = {}) {
    return {
      args: {
        account: ACCOUNT,
        nonce: NONCE,
        day: 20600n,
        streak: 3,
        ...overrides,
      },
    };
  }

  it("lança se o contrato não está configurado", async () => {
    delete process.env.NEXT_PUBLIC_CELO_CHECKIN_CONTRACT_ADDRESS;
    const { verifyCheckInTx } = await loadModule();
    await expect(verifyCheckInTx(TX_HASH)).rejects.toThrow(
      /not configured/
    );
  });

  it("retorna pending quando o receipt ainda não existe (RPC lança)", async () => {
    mockGetTransactionReceipt.mockRejectedValue(new Error("not found"));
    const { verifyCheckInTx } = await loadModule();
    expect(await verifyCheckInTx(TX_HASH)).toEqual({ status: "pending" });
  });

  it("retorna pending quando o receipt é null", async () => {
    mockGetTransactionReceipt.mockResolvedValue(null);
    const { verifyCheckInTx } = await loadModule();
    expect(await verifyCheckInTx(TX_HASH)).toEqual({ status: "pending" });
  });

  it("retorna failed quando a tx reverteu", async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      makeReceipt({ status: "reverted" })
    );
    const { verifyCheckInTx } = await loadModule();
    expect(await verifyCheckInTx(TX_HASH)).toEqual({ status: "failed" });
  });

  it("retorna pending sem confirmações suficientes", async () => {
    mockGetTransactionReceipt.mockResolvedValue(makeReceipt());
    mockBlockNumber.mockResolvedValue(101n); // head - block = 1 < 2
    const { verifyCheckInTx } = await loadModule();
    expect(await verifyCheckInTx(TX_HASH)).toEqual({ status: "pending" });
  });

  it("retorna failed quando não há evento CheckIn do contrato", async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      makeReceipt({ logs: [{ address: OTHER_CONTRACT, topics: [], data: "0x" }] })
    );
    mockBlockNumber.mockResolvedValue(200n);
    mockParseEventLogs.mockReturnValue([]);
    const { verifyCheckInTx } = await loadModule();
    expect(await verifyCheckInTx(TX_HASH)).toEqual({ status: "failed" });
    // Logs de outro contrato nunca chegam ao parser
    expect(mockParseEventLogs).toHaveBeenCalledWith(
      expect.objectContaining({ logs: [] })
    );
  });

  it("retorna confirmed com dados normalizados do evento", async () => {
    mockGetTransactionReceipt.mockResolvedValue(makeReceipt());
    mockBlockNumber.mockResolvedValue(200n);
    mockParseEventLogs.mockReturnValue([makeEvent()]);
    const { verifyCheckInTx } = await loadModule();

    const result = await verifyCheckInTx(TX_HASH);
    expect(result).toEqual({
      status: "confirmed",
      account: ACCOUNT.toLowerCase(),
      nonce: NONCE.toLowerCase(),
      day: 20600,
      streak: 3,
      blockNumber: 100n,
    });
  });

  it("getCeloCheckInNonceKey prefixa corretamente", async () => {
    const { getCeloCheckInNonceKey } = await loadModule();
    expect(getCeloCheckInNonceKey("0xabc")).toBe("celo-checkin:nonce:0xabc");
  });
});
