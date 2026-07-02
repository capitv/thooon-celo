# thooon-celo

On-chain layer for [Thooon](https://thooon.com) on **Celo** — built for the [Celo Proof of Ship](https://celoplatform.notion.site/Proof-of-Ship-17cd5cb803de8060ba10d22a72b549f8) program.

Thooon is a free-to-play creature game (battles, expeditions, crafting). **Play it on MiniPay: [dsv.thooon.com/mini](https://dsv.thooon.com/mini)**. This repo contains the Celo Mainnet smart contract that powers the in-game **daily on-chain check-in** — players inside [MiniPay](https://www.minipay.to/) check in once per day, paying the network fee in stablecoins (USDm via fee abstraction), and earn in-game gold and streak bonuses — plus a [mirror of the full game-side integration](frontend-integration/) (MiniPay detection, EIP-712 sign-in, check-in API, UI). The game itself is a private Next.js 14 codebase; all Celo-facing code is mirrored here.

## ThooonCheckIn.sol

Immutable, ownerless, zero-dependency contract:

- `checkIn(bytes32 nonce)` — one check-in per address per UTC day (`AlreadyCheckedInToday` guard). Emits `CheckIn(account, nonce, day, streak)`.
- `hasCheckedInToday(address)` — free view used by the game client to avoid guaranteed-revert transactions.
- The `nonce` is a server-issued challenge that binds the transaction to a Thooon account. Because MiniPay does not support message signing, **the check-in transaction itself doubles as proof of wallet ownership**: the game backend verifies the receipt + event on Celo RPC and links the wallet to the player profile.

### Deployment

| Network | Chain ID | Address |
|---|---|---|
| Celo Mainnet | 42220 | [`0xC1f51A310170A8f2a5D641db876f6239868D244f`](https://celoscan.io/address/0xC1f51A310170A8f2a5D641db876f6239868D244f) |

Verified on [Sourcify](https://repo.sourcify.dev/contracts/full_match/42220/0xC1f51A310170A8f2a5D641db876f6239868D244f/) (exact match).

### ABI (human-readable)

```
event CheckIn(address indexed account, bytes32 indexed nonce, uint256 day, uint32 streak)
function checkIn(bytes32 nonce)
function hasCheckedInToday(address account) view returns (bool)
function lastCheckInDay(address) view returns (uint256)
function streakOf(address) view returns (uint32)
error AlreadyCheckedInToday()
```

## Development

Requires [Foundry](https://book.getfoundry.sh/).

```bash
forge build
forge test -vvv
```

## Deploy (Celo Mainnet)

```bash
export PRIVATE_KEY=0x...            # deployer EOA funded with ~0.5 CELO
forge script script/Deploy.s.sol --rpc-url https://forno.celo.org --broadcast

# Verification — Sourcify (no API key):
forge verify-contract <ADDRESS> src/ThooonCheckIn.sol:ThooonCheckIn --chain 42220 --verifier sourcify

# Or Celoscan:
export CELOSCAN_API_KEY=...
forge verify-contract <ADDRESS> src/ThooonCheckIn.sol:ThooonCheckIn --chain 42220 \
  --verifier-url https://api.celoscan.io/api --etherscan-api-key $CELOSCAN_API_KEY
```

## Live status (2026-07-02)

The integration is **live in production**. First on-chain check-in: [`0x7e900d…879e`](https://celoscan.io/tx/0x7e900d4e647378bf59a63fc5e47d40b5704e235250208c37e0e018b4bade879e) — verified by the backend, wallet linked, gold credited.

Two client paths share the same challenge → `checkIn(nonce)` → verify backend:

| Path | Wallet | Gas | Status |
|---|---|---|---|
| **Desktop browser** (primary — the player base is desktop-first) | MetaMask / Rabby via thirdweb, auto-reconnect | Native CELO; zero-balance wallets get a one-time **0.2 CELO gas drop** from a small-float hot wallet ([`0xE790…D5dD`](https://celoscan.io/address/0xE79038EE70178880b1eaB6C1b94dF2533FEdD5dD)) | ✅ live |
| **MiniPay** ([dsv.thooon.com/mini](https://dsv.thooon.com/mini)) | Injected MiniPay provider, EIP-712 sign-in | Stablecoin via fee abstraction | Blocked by MiniPay's `-32604` contract-tx restriction for unlisted mini apps; Stage 1 intake pending |

### Fee reality on Celo (measured, not assumed)

The first production check-in cost **0.0276 CELO at 402 gwei**: thirdweb's `sendTransaction` helper doubled the network's `eth_gasPrice` (~200 gwei that day) and tripped MetaMask's *"high site fee"* warning. Two consequences baked into the code:

- The desktop card sends **raw calldata** (`to` + `data` + `chainId` only) so the wallet estimates fees itself — no inflated suggestion, roughly half the cost (~0.014 CELO/check-in).
- The gas drop is sized to the **measured** ~200 gwei reality (0.2 CELO ≈ two weeks of daily check-ins), not the historical 25 gwei from docs.

## Launch checklist (Proof of Ship)

- [x] Deploy `ThooonCheckIn` to Celo Mainnet; record address above
- [x] Verify contract (Sourcify exact match)
- [x] Set Vercel env: `NEXT_PUBLIC_CELO_CHECKIN_CONTRACT_ADDRESS`, `FEATURE_CELO_CHECKIN=true`, `NEXT_PUBLIC_FEATURE_CELO_CHECKIN=true`, `NEXT_PUBLIC_FEATURE_MINIPAY=true`
- [x] Apply the `celo_checkin` Supabase migration
- [x] Desktop check-in (primary player base): `CeloCheckInCardDesktop` + gas drop ported from [`frontend-integration/`](frontend-integration/), `celo_gas_drops` migration applied, hot wallet funded (40 CELO), `CELO_GAS_DROP_PRIVATE_KEY` + `FEATURE_CELO_GAS_DROP=true` set
- [x] First real on-chain check-in verified end-to-end (tx above)
- [ ] Register builder profile + project on [talent.app](https://talent.app/~/earn/celo-proof-of-ship) (public repo URL, contract address, live URL `https://dsv.thooon.com/mini`, path to the `isMiniPay` hook in Data Sources)
- [ ] Join [t.me/proofofship](https://t.me/proofofship) + weekly Office Hours
- [ ] MiniPay Stage 1 intake at [minipay.to/mini-apps](https://minipay.to/mini-apps) — unblocks contract txs inside MiniPay + leaderboard booster
- [ ] In-game announcement driving players to the daily check-in
