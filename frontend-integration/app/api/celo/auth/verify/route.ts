import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseAdminConfigured } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase/server';
import {
  withRateLimit,
  RATE_LIMITS,
  getRateLimitIdentifier,
} from '@/lib/rateLimit';
import {
  getCache,
  deleteCache,
  incrementCache,
  expireCache,
  acquireLock,
  releaseLock,
} from '@/lib/redisCache';
import { CeloAuthVerifySchema } from '@/lib/validation/schemas';
import { celoCheckInGate } from '@/app/api/celo/_helpers';
import { verifyCheckInTx, calcCheckInReward } from '@/lib/celo/checkin';
import {
  getCeloAuthNonceKey,
  verifySelfProofTx,
  verifyLoginSignature,
  celoWalletEmail,
  celoWalletUsername,
  isCeloWalletEmail,
  type CeloAuthChallenge,
} from '@/lib/celo/auth';
import { invalidatePlayerReadCaches } from '@/lib/cache/playerCaches';

// Anti-sybil: teto global de CONTAS NOVAS criadas via wallet por hora.
// Re-logins de contas existentes não contam. Mesmo padrão do
// provision-wallet (SIGNUP_HOURLY_CAP).
const DEFAULT_WALLET_SIGNUP_HOURLY_CAP = 100;

// Teto POR IP: com o login por assinatura a prova é grátis (gerar uma chave
// nova custa zero — antes a network fee da tx era o atrito anti-sybil),
// então um único IP não pode consumir o teto global sozinho.
const DEFAULT_WALLET_SIGNUP_IP_HOURLY_CAP = 5;

function walletSignupCap(): number {
  const fromEnv = Number(process.env.SIGNUP_HOURLY_CAP);
  return Number.isFinite(fromEnv) && fromEnv > 0
    ? fromEnv
    : DEFAULT_WALLET_SIGNUP_HOURLY_CAP;
}

function walletSignupIpCap(): number {
  const fromEnv = Number(process.env.CELO_SIGNUP_IP_HOURLY_CAP);
  return Number.isFinite(fromEnv) && fromEnv > 0
    ? fromEnv
    : DEFAULT_WALLET_SIGNUP_IP_HOURLY_CAP;
}

/**
 * POST /api/celo/auth/verify — "Sign in with MiniPay", passo 2.
 *
 * ANÔNIMA. Verifica a prova de posse da chave — assinatura EIP-712 (método
 * atual) ou tx (checkIn/selfProof, legados) — encontra ou cria a conta
 * Supabase dona da wallet, e devolve um token_hash de magic link — o
 * cliente troca por sessão via supabase.auth.verifyOtp(). Sem email, sem
 * senha, sem captcha: nonce single-use + rate limit + cap horário de
 * signups são o custo anti-abuso.
 */
export async function POST(req: NextRequest) {
  const gated = celoCheckInGate();
  if (gated) return gated;

  const rateLimitCheck = await withRateLimit(req, RATE_LIMITS.CELO_VERIFY);
  if (!rateLimitCheck.allowed) return rateLimitCheck.response;

  if (!isSupabaseAdminConfigured() || !supabaseAdmin) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }
  const admin = supabaseAdmin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = CeloAuthVerifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const txHash = parsed.data.txHash?.toLowerCase() as `0x${string}` | undefined;
  const signature = parsed.data.signature?.toLowerCase() as
    | `0x${string}`
    | undefined;
  const nonce = parsed.data.nonce.toLowerCase();

  // 1) Challenge precisa existir (vinculado à wallet, não a um usuário —
  //    não há sessão ainda).
  const nonceKey = getCeloAuthNonceKey(nonce);
  const challenge = await getCache<CeloAuthChallenge>(nonceKey);
  if (!challenge) {
    return NextResponse.json(
      { error: 'Challenge expired or already used' },
      { status: 400 }
    );
  }
  const wallet = challenge.walletAddress;

  // 2) Verificação da prova conforme o método. Nonce intacto em
  //    pending/failed/erro.
  let checkInResult: { day: number; txHash: `0x${string}` } | null = null;
  try {
    if (challenge.method === 'signature') {
      if (!signature) {
        return NextResponse.json(
          { error: 'Signature required for this challenge' },
          { status: 400 }
        );
      }
      const valid = await verifyLoginSignature({
        walletAddress: wallet,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt,
        signature,
      });
      if (!valid) {
        return NextResponse.json(
          { error: 'Signature does not match challenge' },
          { status: 403 }
        );
      }
    } else if (challenge.method === 'checkIn') {
      if (!txHash) {
        return NextResponse.json(
          { error: 'Transaction hash required for this challenge' },
          { status: 400 }
        );
      }
      const verification = await verifyCheckInTx(txHash);
      if (verification.status === 'pending') {
        return NextResponse.json(
          { pending: true, retryAfterMs: 2000 },
          { status: 202 }
        );
      }
      if (
        verification.status === 'failed' ||
        verification.nonce !== challenge.nonce.toLowerCase() ||
        verification.account !== wallet
      ) {
        return NextResponse.json(
          { error: 'Transaction does not match challenge' },
          { status: 403 }
        );
      }
      checkInResult = { day: verification.day, txHash };
    } else {
      if (!txHash) {
        return NextResponse.json(
          { error: 'Transaction hash required for this challenge' },
          { status: 400 }
        );
      }
      const verification = await verifySelfProofTx(txHash, {
        walletAddress: wallet,
        nonce: challenge.nonce,
      });
      if (verification.status === 'pending') {
        return NextResponse.json(
          { pending: true, retryAfterMs: 2000 },
          { status: 202 }
        );
      }
      if (verification.status === 'failed') {
        return NextResponse.json(
          { error: 'Transaction does not match challenge' },
          { status: 403 }
        );
      }
    }
  } catch (error) {
    console.error(
      '[celo-auth] verification RPC error:',
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      { error: 'Verification temporarily unavailable' },
      { status: 503 }
    );
  }

  // 2.5) Consumo atômico do challenge: SET NX garante que só UM verify com
  // este nonce prossegue — sem isso, dois POSTs concorrentes passariam no
  // getCache antes do deleteCache do passo 6 e mintariam duas sessões.
  // Lock liberado no finally: em sucesso o challenge já foi deletado
  // (replay impossível); em falha transitória o usuário pode tentar de
  // novo na hora, sem esperar TTL.
  const consumeLockKey = `celo-auth:consume:${nonce}`;
  const consumed = await acquireLock(consumeLockKey, 60);
  if (!consumed) {
    return NextResponse.json(
      { error: 'Sign-in already in progress' },
      { status: 409 }
    );
  }

  const completeSignIn = async (): Promise<NextResponse> => {
    // 3) Encontrar a conta dona da wallet (link feito por tx verificada no
    //    passado) ou criar uma nova.
    // .eq (não .ilike): coluna armazenada lowercase + wallet já normalizada;
    // match exato usa o índice único e não tem semântica de wildcard.
    const { data: existingProfile } = await admin
      .from('profiles')
      .select('id, email')
      .eq('celo_wallet_address', wallet)
      .limit(1)
      .maybeSingle();

    let userId: string;
    let email: string;
    let isNewUser = false;

    if (existingProfile) {
      userId = existingProfile.id;
      const { data: userData, error: userErr } =
        await admin.auth.admin.getUserById(userId);
      if (userErr || !userData?.user?.email) {
        console.error('[celo-auth] getUserById failed:', userErr?.message);
        return NextResponse.json(
          { error: 'Account lookup failed' },
          { status: 500 }
        );
      }
      email = userData.user.email;

      // Posse da wallet só dá sessão a contas NATIVAS de wallet (email
      // sintético). Conta de email real que vinculou a wallet no hub entra
      // pela porta da frente (senha + captcha) — senão este endpoint
      // anônimo viraria um bypass de captcha/senha pra essas contas.
      if (!isCeloWalletEmail(email)) {
        console.warn(
          '[celo-auth] wallet login blocked for email-origin account:',
          userId
        );
        return NextResponse.json(
          {
            error:
              'This wallet is linked to an email account. Sign in with your email instead.',
          },
          { status: 403 }
        );
      }
    } else {
      // Tetos de signups/hora (anti-sybil): POR IP primeiro (um IP nunca
      // consome o orçamento global sozinho), depois global. A prova por
      // assinatura é grátis — gerar chave nova custa zero (antes a network
      // fee da tx era o atrito) — então o atrito anti-bot é todo aqui.
      // FAIL-CLOSED: incrementCache devolve 0/null em erro de Redis; tratar
      // como indisponível em vez de deixar o cap silenciosamente desligado.
      const hourSlice = new Date().toISOString().slice(0, 13);

      const ipBucket = `celo-auth:signup-ip:${getRateLimitIdentifier(req)}:${hourSlice}`;
      const ipCount = await incrementCache(ipBucket);
      if (!ipCount || ipCount <= 0) {
        return NextResponse.json(
          { error: 'Service unavailable' },
          { status: 503 }
        );
      }
      if (ipCount === 1) await expireCache(ipBucket, 3700);
      if (ipCount > walletSignupIpCap()) {
        return NextResponse.json(
          {
            error: 'Too many new accounts from this network. Try again later.',
          },
          { status: 429 }
        );
      }

      const hourBucket = `celo-auth:signup-hour:${hourSlice}`;
      const count = await incrementCache(hourBucket);
      if (!count || count <= 0) {
        return NextResponse.json(
          { error: 'Service unavailable' },
          { status: 503 }
        );
      }
      if (count === 1) await expireCache(hourBucket, 3700);
      if (count > walletSignupCap()) {
        // Devolve o slot: esta request não criou conta.
        await incrementCache(hourBucket, -1).catch(() => {});
        return NextResponse.json(
          { error: 'Too many new accounts right now. Try again later.' },
          { status: 429 }
        );
      }

      email = celoWalletEmail(wallet);
      const { data: created, error: createErr } =
        await admin.auth.admin.createUser({
          email,
          email_confirm: true,
          user_metadata: {
            username: celoWalletUsername(wallet),
            celo_wallet_address: wallet,
            auth_origin: 'minipay',
          },
        });

      if (createErr) {
        // Corrida: outra request criou o mesmo usuário — segue com o email
        // determinístico (generateLink encontra a conta).
        if (!/already|exists|registered/i.test(createErr.message)) {
          console.error('[celo-auth] createUser failed:', createErr.message);
          // Falha real não consome orçamento de signup.
          await incrementCache(hourBucket, -1).catch(() => {});
          return NextResponse.json(
            { error: 'Account creation failed' },
            { status: 500 }
          );
        }
        const { data: profByEmail } = await admin
          .from('profiles')
          .select('id')
          .eq('email', email)
          .limit(1)
          .maybeSingle();
        if (!profByEmail) {
          return NextResponse.json(
            { error: 'Account creation failed' },
            { status: 500 }
          );
        }
        userId = profByEmail.id;
      } else {
        userId = created.user.id;
        isNewUser = true;
      }
    }

    // 4) Link da wallet + (se método checkIn) fato do dia + gold, atômico.
    let checkIn: { streak: number; goldAwarded: number } | null = null;
    if (checkInResult) {
      const yesterdayDate = new Date((checkInResult.day - 1) * 86400 * 1000)
        .toISOString()
        .slice(0, 10);
      const { data: yesterdayCheckIn } = await admin
        .from('celo_checkins')
        .select('streak_day')
        .eq('profile_id', userId)
        .eq('check_day', yesterdayDate)
        .limit(1)
        .maybeSingle();
      const expectedStreak = (yesterdayCheckIn?.streak_day ?? 0) + 1;

      const { data: rpcResult, error: rpcError } = await admin.rpc(
        'record_celo_checkin',
        {
          p_profile_id: userId,
          p_wallet: wallet,
          p_tx_hash: checkInResult.txHash,
          p_nonce: nonce,
          p_chain_day: checkInResult.day,
          p_gold: calcCheckInReward(expectedStreak),
        }
      );
      const result = rpcResult as {
        success: boolean;
        error?: string;
        streak_day?: number;
        gold_awarded?: number;
      } | null;

      if (rpcError || !result?.success) {
        const code = result?.error ?? rpcError?.message;
        if (code === 'wallet_conflict') {
          return NextResponse.json(
            { error: 'Wallet already linked to another account' },
            { status: 409 }
          );
        }
        // already_claimed/tx_already_used: corrida benigna — login segue,
        // só não credita de novo.
        if (code !== 'already_claimed' && code !== 'tx_already_used') {
          console.error('[celo-auth] record_celo_checkin failed:', code);
          return NextResponse.json(
            { error: 'Failed to record check-in' },
            { status: 500 }
          );
        }
      } else {
        checkIn = {
          streak: result.streak_day ?? 1,
          goldAwarded: result.gold_awarded ?? 0,
        };
      }
    } else {
      // selfProof: garantir o link (perfil pode ter sido recém-criado).
      const { error: linkErr } = await admin
        .from('profiles')
        .update({
          celo_wallet_address: wallet,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId);
      if (linkErr) {
        if ((linkErr as { code?: string }).code === '23505') {
          return NextResponse.json(
            { error: 'Wallet already linked to another account' },
            { status: 409 }
          );
        }
        console.error('[celo-auth] wallet link failed:', linkErr.message);
        return NextResponse.json(
          { error: 'Failed to link wallet' },
          { status: 500 }
        );
      }
    }

    // 5) Sessão: magic link gerado server-side; o token_hash volta pro
    //    cliente, que troca por sessão via verifyOtp. Nenhum email é enviado.
    const { data: linkData, error: linkError } =
      await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (linkError || !linkData?.properties?.hashed_token) {
      console.error('[celo-auth] generateLink failed:', linkError?.message);
      return NextResponse.json(
        { error: 'Session creation failed' },
        { status: 500 }
      );
    }

    // 6) Nonce consumido só após sucesso total.
    await deleteCache(nonceKey);
    await invalidatePlayerReadCaches({ profileId: userId }).catch(() => {});

    return NextResponse.json({
      tokenHash: linkData.properties.hashed_token,
      isNewUser,
      checkIn,
    });
  };

  try {
    return await completeSignIn();
  } finally {
    await releaseLock(consumeLockKey).catch(() => {});
  }
}
