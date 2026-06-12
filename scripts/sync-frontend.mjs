#!/usr/bin/env node
/**
 * Mirrors the Celo/MiniPay integration code from the main Thooon game repo
 * (private) into `frontend-integration/` in this public repo.
 *
 * Safety: every file is scanned for secret-looking content BEFORE being
 * written. Any hit aborts the whole sync with a non-zero exit code — nothing
 * is copied on failure.
 *
 * Usage:  node scripts/sync-frontend.mjs [path-to-game-repo]
 * Default game repo path: ../site (i.e. D:\thooon\site when run from repo root)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const GAME_ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, "..", "..", "site"));
const DEST_ROOT = resolve(import.meta.dirname, "..", "frontend-integration");

/** Source path (relative to game repo) → dest path (relative to frontend-integration/). */
const FILES = [
  // MiniPay environment detection + raw provider helpers
  ["src/lib/minipay.ts", "lib/minipay.ts"],
  ["src/hooks/useMiniPay.ts", "hooks/useMiniPay.ts"],
  // EIP-712 sign-in (MiniPay has no SIWE/personal_sign-based session support)
  ["src/lib/celo/auth.ts", "lib/celo/auth.ts"],
  ["src/lib/celo/__tests__/auth.test.ts", "lib/celo/__tests__/auth.test.ts"],
  // On-chain check-in verification (receipt + event parsing)
  ["src/lib/celo/checkin.ts", "lib/celo/checkin.ts"],
  ["src/lib/celo/__tests__/checkin.test.ts", "lib/celo/__tests__/checkin.test.ts"],
  ["src/lib/thirdweb/chains.ts", "lib/thirdweb/chains.ts"],
  // API routes (Next.js App Router): Zod → auth → rate limit → domain logic
  ["src/app/api/celo/_helpers.ts", "app/api/celo/_helpers.ts"],
  ["src/app/api/celo/auth/challenge/route.ts", "app/api/celo/auth/challenge/route.ts"],
  ["src/app/api/celo/auth/verify/route.ts", "app/api/celo/auth/verify/route.ts"],
  ["src/app/api/celo/auth/__tests__/verify.route.test.ts", "app/api/celo/auth/__tests__/verify.route.test.ts"],
  ["src/app/api/celo/check-in/challenge/route.ts", "app/api/celo/check-in/challenge/route.ts"],
  ["src/app/api/celo/check-in/status/route.ts", "app/api/celo/check-in/status/route.ts"],
  ["src/app/api/celo/check-in/verify/route.ts", "app/api/celo/check-in/verify/route.ts"],
  ["src/app/api/celo/check-in/__tests__/challenge.route.test.ts", "app/api/celo/check-in/__tests__/challenge.route.test.ts"],
  ["src/app/api/celo/check-in/__tests__/verify.route.test.ts", "app/api/celo/check-in/__tests__/verify.route.test.ts"],
  // MiniPay entry route (lightweight, no thirdweb bundle)
  ["src/app/[locale]/mini/page.tsx", "app/[locale]/mini/page.tsx"],
  ["src/app/[locale]/mini/MiniEntryClient.tsx", "app/[locale]/mini/MiniEntryClient.tsx"],
  // UI: floating daily check-in card (confetti, auto-dismiss)
  ["src/components/celo/CeloCheckInCard.tsx", "components/celo/CeloCheckInCard.tsx"],
  // Supabase migration: link + fact + credit in one transaction
  ["supabase/migrations/20260610_celo_checkin.sql", "backend/migrations/20260610_celo_checkin.sql"],
];

/** Patterns that indicate a leaked secret. */
const SECRET_PATTERNS = [
  { name: "32-byte hex (private key?)", re: /0x[a-fA-F0-9]{64}/g, allow: (m) => /^0x(.)\1{63}$/.test(m) },
  { name: "JWT", re: /eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}/g },
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY/g },
  { name: "live/test API key", re: /\b[sp]k_(live|test)_[A-Za-z0-9]{10,}/g },
  { name: "hardcoded secret assignment", re: /(secret|password|service_role|api[_-]?key)\s*[:=]\s*["'][A-Za-z0-9+/_-]{16,}["']/gi },
];

let failed = false;
const staged = [];

for (const [src, dest] of FILES) {
  const srcPath = join(GAME_ROOT, src);
  let content;
  try {
    content = readFileSync(srcPath, "utf8");
  } catch {
    console.error(`MISSING  ${src}`);
    failed = true;
    continue;
  }
  for (const { name, re, allow } of SECRET_PATTERNS) {
    for (const m of content.matchAll(re)) {
      if (allow?.(m[0])) continue;
      const line = content.slice(0, m.index).split("\n").length;
      console.error(`LEAK?    ${src}:${line}  [${name}]  ${m[0].slice(0, 24)}…`);
      failed = true;
    }
  }
  staged.push([dest, content]);
}

if (failed) {
  console.error("\nSync ABORTED — fix the issues above. Nothing was written.");
  process.exit(1);
}

for (const [dest, content] of staged) {
  const destPath = join(DEST_ROOT, dest);
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, content);
  console.log(`synced   ${dest}`);
}
console.log(`\n${staged.length} files synced into frontend-integration/. Review with: git diff`);
