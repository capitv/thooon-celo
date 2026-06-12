-- ============================================================================
-- Celo daily check-in (Proof of Ship / MiniPay)
-- ----------------------------------------------------------------------------
-- O MiniPay não suporta assinatura de mensagem, então a tx de check-in no
-- contrato ThooonCheckIn (Celo Mainnet, 42220) cumpre papel duplo: prova
-- posse da chave (substitui o SIWE para wallets Celo) e gera atividade
-- on-chain recorrente.
--
-- profiles.celo_wallet_address é DELIBERADAMENTE separada de wallet_address
-- (semântica Berachain: staking/NFT/ADMIN_WALLETS) e de
-- thirdweb_wallet_address (embedded wallet). Coluna chain-tagged.
--
-- record_celo_checkin faz link + fato + crédito em UMA transação (regra da
-- casa: nunca read-then-write entre statements a partir do app).
-- ============================================================================

-- 1) Coluna de wallet Celo no perfil (lowercase, convenção do backfill 20260423)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS celo_wallet_address TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_celo_wallet_address_uniq
  ON profiles (celo_wallet_address)
  WHERE celo_wallet_address IS NOT NULL;

-- 2) Tabela de fatos (modelada em daily_claims)
CREATE TABLE IF NOT EXISTS celo_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  -- Derivada do `day` do EVENTO on-chain (uint = epoch/86400), não do clock
  -- do servidor — evita o bug de fronteira tx minerada 23:59 / verificada 00:01.
  check_day DATE NOT NULL,
  chain_day INTEGER NOT NULL,
  streak_day INTEGER NOT NULL CHECK (streak_day >= 1),
  gold_awarded INTEGER NOT NULL CHECK (gold_awarded >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Um check-in por dia UTC por perfil; uma tx nunca credita duas contas.
CREATE UNIQUE INDEX IF NOT EXISTS idx_celo_checkins_profile_day
  ON celo_checkins(profile_id, check_day);
CREATE UNIQUE INDEX IF NOT EXISTS idx_celo_checkins_tx_hash
  ON celo_checkins(tx_hash);
CREATE INDEX IF NOT EXISTS idx_celo_checkins_profile_recent
  ON celo_checkins(profile_id, created_at DESC);

ALTER TABLE celo_checkins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "celo_checkins_own_read" ON celo_checkins;
CREATE POLICY "celo_checkins_own_read" ON celo_checkins
  FOR SELECT
  USING (profile_id = auth.uid());

-- 3) RPC atômica: link de wallet + fato de check-in + crédito de gold.
--    Retorna JSONB { success, error?, streak_day?, gold_awarded? }.
CREATE OR REPLACE FUNCTION record_celo_checkin(
  p_profile_id UUID,
  p_wallet TEXT,
  p_tx_hash TEXT,
  p_nonce TEXT,
  p_chain_day INTEGER,
  p_gold INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet TEXT := lower(p_wallet);
  v_check_day DATE := to_timestamp(p_chain_day::bigint * 86400)::date;
  v_prev_streak INTEGER;
  v_streak INTEGER;
  v_gold INTEGER;
  v_conflict UUID;
  v_ledger JSONB;
BEGIN
  -- Wallet já vinculada a outro perfil → conflito (anti-takeover).
  SELECT id INTO v_conflict
  FROM profiles
  WHERE celo_wallet_address = v_wallet
    AND id <> p_profile_id
  LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'wallet_conflict');
  END IF;

  -- Link/overwrite (política de troca de wallet espelha a rota SIWE).
  UPDATE profiles
  SET celo_wallet_address = v_wallet,
      updated_at = NOW()
  WHERE id = p_profile_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'profile_not_found');
  END IF;

  -- Streak derivado da PRÓPRIA tabela (por perfil) — troca de wallet não
  -- transfere nem infla streak; o evento on-chain é por endereço e é apenas
  -- cosmético.
  SELECT streak_day INTO v_prev_streak
  FROM celo_checkins
  WHERE profile_id = p_profile_id
    AND check_day = v_check_day - 1;
  v_streak := COALESCE(v_prev_streak, 0) + 1;

  -- Clamp defensivo (o app também clampa antes de chamar).
  v_gold := LEAST(GREATEST(p_gold, 0), 50);

  BEGIN
    INSERT INTO celo_checkins (
      profile_id, wallet_address, tx_hash, nonce,
      check_day, chain_day, streak_day, gold_awarded
    ) VALUES (
      p_profile_id, v_wallet, lower(p_tx_hash), p_nonce,
      v_check_day, p_chain_day, v_streak, v_gold
    );
  EXCEPTION WHEN unique_violation THEN
    -- (profile_id, check_day) OU tx_hash — distinguir pelo constraint.
    IF EXISTS (SELECT 1 FROM celo_checkins WHERE tx_hash = lower(p_tx_hash)) THEN
      RETURN jsonb_build_object('success', false, 'error', 'tx_already_used');
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'already_claimed');
  END;

  -- Crédito na MESMA transação: falha aqui → rollback total (sem fato órfão).
  IF v_gold > 0 THEN
    v_ledger := apply_points_delta(
      p_profile_id => p_profile_id,
      p_amount => v_gold,
      p_direction => 'credit',
      p_source_type => 'celo_checkin',
      p_title => ('Celo Day ' || v_streak || ' Check-In')::varchar(200),
      p_metadata => jsonb_build_object(
        'streak_day', v_streak,
        'tx_hash', lower(p_tx_hash),
        'chain_day', p_chain_day
      ),
      p_currency => 'gold'
    );
    IF v_ledger IS NULL OR COALESCE((v_ledger->>'success')::boolean, false) = false THEN
      RAISE EXCEPTION 'apply_points_delta failed: %', COALESCE(v_ledger->>'error', 'unknown');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'streak_day', v_streak,
    'gold_awarded', v_gold,
    'check_day', v_check_day
  );
END;
$$;

-- Server-only: nunca exposta via PostgREST a usuários autenticados
-- (convenções 20260311_harden_public_function_access + 20260516_revoke).
REVOKE EXECUTE ON FUNCTION public.record_celo_checkin(UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER)
  FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.record_celo_checkin(UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER)
  TO service_role;
