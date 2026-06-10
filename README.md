# thooon-celo

On-chain layer for [Thooon](https://thooon.com) on **Celo** — built for the [Celo Proof of Ship](https://celoplatform.notion.site/Proof-of-Ship-17cd5cb803de8060ba10d22a72b549f8) program.

Thooon is a free-to-play creature game (battles, expeditions, crafting) live at [thooon.com](https://thooon.com). This repo contains the Celo Mainnet smart contract that powers the in-game **daily on-chain check-in**: players inside [MiniPay](https://www.minipay.to/) check in once per day, paying the network fee in stablecoins (USDm via fee abstraction), and earn in-game gold and streak bonuses.

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

## Launch checklist (Proof of Ship)

- [x] Deploy `ThooonCheckIn` to Celo Mainnet; record address above
- [x] Verify contract (Sourcify exact match)
- [ ] Set Vercel env: `NEXT_PUBLIC_CELO_CHECKIN_CONTRACT_ADDRESS`, `FEATURE_CELO_CHECKIN=true`, `NEXT_PUBLIC_FEATURE_CELO_CHECKIN=true`, `NEXT_PUBLIC_FEATURE_MINIPAY=true`
- [ ] Apply the `celo_checkin` Supabase migration
- [ ] Register builder profile + project on [talent.app](https://talent.app/~/earn/celo-proof-of-ship) (public repo URL, contract address, live URL `https://thooon.com/mini`, path to the `isMiniPay` hook in Data Sources)
- [ ] Join [t.me/proofofship](https://t.me/proofofship) + weekly Office Hours
- [ ] After stable on device: MiniPay Stage 1 intake at [minipay.to/mini-apps](https://minipay.to/mini-apps)
