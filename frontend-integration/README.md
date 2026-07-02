# Frontend integration (mirror)

This folder is a **read-only mirror** of the Celo/MiniPay integration code that lives in the main Thooon game repo (a private Next.js 14 monolith — the rest of the game is closed-source for economy/anti-cheat reasons). Paths mirror the game's `src/` layout, so imports like `@/lib/...` reference game-repo modules and this folder does not build standalone.

Synced via [`scripts/sync-frontend.mjs`](../scripts/sync-frontend.mjs), which scans every file for secret-looking content before writing anything.

## What's here

| Area | Files | Role |
|---|---|---|
| MiniPay detection | `lib/minipay.ts`, `hooks/useMiniPay.ts` | SSR-safe `isMiniPay` detection, raw `window.ethereum` helpers, `checkIn(bytes32)` tx encoding with USDm `feeCurrency` (CIP-64) |
| Sign in with MiniPay | `lib/celo/auth.ts`, `app/api/celo/auth/*` | MiniPay has no SIWE — login is an **EIP-712 typed-data signature** (`Login{wallet,nonce,issuedAt}`), verified server-side via viem `recoverTypedDataAddress`, bound to a Redis-backed one-time nonce |
| Daily check-in | `lib/celo/checkin.ts`, `app/api/celo/check-in/*` | Challenge → user sends `checkIn(nonce)` to [`ThooonCheckIn`](../src/ThooonCheckIn.sol) on Celo Mainnet → server verifies receipt + `CheckIn` event (≥2 confirmations, nonce/account binding) → atomic Supabase RPC links wallet, records the fact, credits gold |
| Client check-in flow | `lib/celo/checkinFlow.ts` | Wallet-agnostic client side of the flow (challenge request + verify polling); the tx send is injected per environment — MiniPay raw provider vs thirdweb desktop |
| Entry route | `app/[locale]/mini/*` | Lightweight `/mini` entry point (no thirdweb in the bundle) — detects MiniPay, auto-connects, routes into the game |
| UI (MiniPay) | `components/celo/CeloCheckInCard.tsx` | Floating daily check-in card inside MiniPay: streak display, confetti on claim, auto-dismiss, never offers a guaranteed-revert tx (checks `hasCheckedInToday` first) |
| UI (desktop) | `components/celo/CeloCheckInCardDesktop.tsx` | Same card for the desktop/browser game: connects the player's thirdweb wallet (MetaMask, Rabby, WalletConnect…), auto-switches to Celo, sends `checkIn(nonce)` with native CELO gas — unblocked by the MiniPay `-32604` contract-tx restriction. Zero-balance wallets get a "Get gas" button; a broadcast tx that outlives the verify window is persisted per wallet+day and RESUMED (same txHash/nonce) instead of minting a second guaranteed-revert tx |
| UI (shared shell) | `components/celo/CheckInCardShell.tsx` | Presentational chrome (floating card, confetti, title/subtitle/message) shared by both cards so they never drift visually |
| Gas drop | `lib/celo/gasDrop.ts` (server), `lib/celo/gasDropClient.ts`, `lib/celo/gasDropConfig.ts`, `app/api/celo/gas-drop/route.ts` | Faucet for the desktop check-in: sends 0.02 CELO from a small-float hot wallet to eligible players (account age gate, once per profile AND per wallet via DB unique indexes, global daily cap, recipient balance check). Reservation row is inserted BEFORE the send so concurrent requests can never double-pay |
| Database | `backend/migrations/20260610_celo_checkin.sql`, `backend/migrations/20260702_celo_gas_drops.sql` | `celo_wallet_address` profile column (chain-tagged, separate from other chains), `celo_checkins` fact table with RLS, `record_celo_checkin` SECURITY DEFINER RPC — link + fact + credit in one transaction; `celo_gas_drops` reservation/audit table (unique per profile and per wallet) |

## Design notes

- **Tx as proof of ownership.** MiniPay cannot sign loose messages in a way our SIWE flow accepts, so the check-in transaction doubles as wallet-link proof: the server-issued nonce rides in `checkIn(bytes32)` and the backend only links a wallet after seeing that nonce in the on-chain event from that address.
- **API route convention** (house style): Supabase auth → Redis rate limit → Zod schema validation → domain logic. Every route here follows it; tests are colocated in `__tests__/`.
- **Demo-safe flags.** Everything is gated behind `FEATURE_CELO_CHECKIN` / `NEXT_PUBLIC_FEATURE_MINIPAY` env flags — the game runs with zero Celo config.
- **Known MiniPay constraint (open).** In MiniPay developer mode, `eth_sendTransaction` to a contract returns `-32604 Permission denied` without a popup. The card currently falls back to a visual-only success (clearly marked in code, no gold/no on-chain record) so the UX has an exit; real on-chain check-in resumes once the restriction is lifted for unlisted mini apps.
- **Desktop path (primary).** The player base is desktop-first, so the same challenge/verify backend also serves the browser game via `CeloCheckInCardDesktop` + thirdweb — no MiniPay listing required for on-chain activity. The backend never knew about MiniPay: the nonce binds userId + wallet, and any wallet that emits the `CheckIn` event with that nonce passes verification.
- **Gas drop, not a relayer.** `ThooonCheckIn` records `msg.sender`, so a server-relayed tx would collapse every player into one on-chain address. The faucet keeps each player as the sender of their own tx (unique wallets / DAU / fees stay per-player) at ~US$0.01 per player. Sybil resistance comes from game data the server already has (account age; harden with game progress on port), plus one-drop-ever per profile/wallet and a global daily cap.
- **Port note.** `CeloGasDropSchema` (`{ walletAddress: 0x-hex }`) must be added to `@/lib/validation/schemas` in the game repo, and `CELO_GAS_DROP_PRIVATE_KEY` + `FEATURE_CELO_GAS_DROP` to the Vercel env (hot wallet key ≠ deployer key; keep a 10–20 CELO float).
