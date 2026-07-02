/**
 * Testes da lib server do gas drop — thirdweb mockado por completo.
 */

const HOT_WALLET = "0x9999000000000000000000000000000000000009";
const RECIPIENT = "0xabcd000000000000000000000000000000000001";
const TX_HASH =
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

const mockGetBalance = jest.fn();
const mockSendTransaction = jest.fn();
const mockPrepareTransaction = jest.fn((tx: unknown) => tx);

jest.mock("server-only", () => ({}));

jest.mock("thirdweb/rpc", () => ({
  getRpcClient: jest.fn(() => ({})),
  eth_getBalance: (...args: unknown[]) => mockGetBalance(...args),
}));

jest.mock("thirdweb", () => ({
  prepareTransaction: (...args: unknown[]) => mockPrepareTransaction(...args),
  sendTransaction: (...args: unknown[]) => mockSendTransaction(...args),
}));

jest.mock("thirdweb/wallets", () => ({
  privateKeyToAccount: jest.fn(({ privateKey }: { privateKey: string }) => ({
    address: HOT_WALLET,
    privateKey,
  })),
}));

jest.mock("@/lib/thirdweb", () => ({
  thirdwebClient: {},
}));

describe("gasDrop (server lib)", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.FEATURE_CELO_GAS_DROP = "true";
    process.env.CELO_GAS_DROP_PRIVATE_KEY = "0xdeadbeef";
  });

  afterAll(() => {
    delete process.env.FEATURE_CELO_GAS_DROP;
    delete process.env.CELO_GAS_DROP_PRIVATE_KEY;
  });

  async function loadModule() {
    return import("../gasDrop");
  }

  describe("isGasDropConfigured", () => {
    it("true com flag + chave", async () => {
      const { isGasDropConfigured } = await loadModule();
      expect(isGasDropConfigured()).toBe(true);
    });

    it("false sem flag", async () => {
      process.env.FEATURE_CELO_GAS_DROP = "false";
      const { isGasDropConfigured } = await loadModule();
      expect(isGasDropConfigured()).toBe(false);
    });

    it("false sem chave", async () => {
      delete process.env.CELO_GAS_DROP_PRIVATE_KEY;
      const { isGasDropConfigured } = await loadModule();
      expect(isGasDropConfigured()).toBe(false);
    });
  });

  describe("recipientHasEnoughGas", () => {
    it("true no threshold exato (0.005 CELO)", async () => {
      mockGetBalance.mockResolvedValue(5_000_000_000_000_000n);
      const { recipientHasEnoughGas } = await loadModule();
      expect(await recipientHasEnoughGas(RECIPIENT)).toBe(true);
    });

    it("false abaixo do threshold", async () => {
      mockGetBalance.mockResolvedValue(4_999_999_999_999_999n);
      const { recipientHasEnoughGas } = await loadModule();
      expect(await recipientHasEnoughGas(RECIPIENT)).toBe(false);
    });
  });

  describe("hotWalletCanFund", () => {
    it("false quando o float não cobre drop + margem de gas", async () => {
      // 0.02 (drop) + 0.001 (margem) = 0.021 exigido
      mockGetBalance.mockResolvedValue(20_999_999_999_999_999n);
      const { hotWalletCanFund, getGasDropAccount } = await loadModule();
      expect(await hotWalletCanFund(getGasDropAccount()!)).toBe(false);
    });

    it("true quando cobre", async () => {
      mockGetBalance.mockResolvedValue(21_000_000_000_000_000n);
      const { hotWalletCanFund, getGasDropAccount } = await loadModule();
      expect(await hotWalletCanFund(getGasDropAccount()!)).toBe(true);
    });
  });

  describe("sendGasDrop", () => {
    it("prepara tx de 0.02 CELO para o destinatário e devolve o hash", async () => {
      mockSendTransaction.mockResolvedValue({ transactionHash: TX_HASH });
      const { sendGasDrop, getGasDropAccount } = await loadModule();

      const txHash = await sendGasDrop(getGasDropAccount()!, RECIPIENT);

      expect(txHash).toBe(TX_HASH);
      expect(mockPrepareTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          to: RECIPIENT,
          value: 20_000_000_000_000_000n,
        })
      );
      expect(mockSendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          account: expect.objectContaining({ address: HOT_WALLET }),
        })
      );
    });
  });
});
