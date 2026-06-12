# Frontend integration (mirror)

This folder is a **read-only mirror** of the Celo/MiniPay integration code that lives in the main Thooon game repo (a private Next.js 14 monolith — the rest of the game is closed-source for economy/anti-cheat reasons). Paths mirror the game's `src/` layout, so imports like `@/lib/...` reference game-repo modules and this folder does not build standalone.

Synced via [`scripts/sync-frontend.mjs`](../scripts/sync-frontend.mjs), which scans every file for secret-looking content before writing anything.

## What's here

| Area | Files | Role |
|---|---|---|
| MiniPay detection | `lib/minipay.ts`, `hooks/useMiniPay.ts` | SSR-safe `isMiniPay` detection, raw `window.ethereum` helpers, `checkIn(bytes32)` tx encoding with USDm `feeCurrency` (CIP-64) |
| Sign in with MiniPay | `lib/celo/auth.ts`, `app/api/celo/auth/*` | MiniPay has no SIWE — login is an **EIP-712 typed-data signature** (`Login{wallet,nonce,issuedAt}`), verified server-side via viem `recoverTypedDataAddress`, bound to a Redis-backed one-time nonce |
| Daily check-in | `lib/celo/checkin.ts`, `app/api/celo/check-in/*` | Challenge → user sends `checkIn(nonce)` to [`ThooonCheckIn`](../src/ThooonCheckIn.sol) on Celo Mainnet → server verifies receipt + `CheckIn` event (≥2 confirmations, nonce/account binding) → atomic Supabase RPC links wallet, records the fact, credits gold |
| Entry route | `app/[locale]/mini/*` | Lightweight `/mini` entry point (no thirdweb in the bundle) — detects MiniPay, auto-connects, routes into the game |
| UI | `components/celo/CeloCheckInCard.tsx` | Floating daily check-in card: streak display, confetti on claim, auto-dismiss, never offers a guaranteed-revert tx (checks `hasCheckedInToday` first) |
| Database | `backend/migrations/20260610_celo_checkin.sql` | `celo_wallet_address` profile column (chain-tagged, separate from other chains), `celo_checkins` fact table with RLS, `record_celo_checkin` SECURITY DEFINER RPC — link + fact + credit in one transaction |

## Design notes

- **Tx as proof of ownership.** MiniPay cannot sign loose messages in a way our SIWE flow accepts, so the check-in transaction doubles as wallet-link proof: the server-issued nonce rides in `checkIn(bytes32)` and the backend only links a wallet after seeing that nonce in the on-chain event from that address.
- **API route convention** (house style): Zod schema validation → Supabase auth → Redis rate limit → domain logic. Every route here follows it; tests are colocated in `__tests__/`.
- **Demo-safe flags.** Everything is gated behind `FEATURE_CELO_CHECKIN` / `NEXT_PUBLIC_FEATURE_MINIPAY` env flags — the game runs with zero Celo config.
- **Known MiniPay constraint (open).** In MiniPay developer mode, `eth_sendTransaction` to a contract returns `-32604 Permission denied` without a popup. The card currently falls back to a visual-only success (clearly marked in code, no gold/no on-chain record) so the UX has an exit; real on-chain check-in resumes once the restriction is lifted for unlisted mini apps.
