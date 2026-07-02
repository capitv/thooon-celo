-- ============================================================================
-- Celo gas drop (faucet do check-in desktop)
-- ----------------------------------------------------------------------------
-- Jogadores desktop pagam o gas do check-in em CELO nativo (sem fee
-- abstraction fora do MiniPay). O gas drop envia 0.02 CELO da hot wallet
-- para wallets de jogadores elegíveis — uma vez por conta E por wallet.
--
-- A tabela é a fonte de verdade da unicidade: a rota INSERE a reserva
-- (status 'pending') ANTES de enviar a tx. Requests concorrentes do mesmo
-- perfil/wallet morrem no unique index, nunca em read-then-write no app
-- (regra da casa). Falha no envio → rota deleta a reserva (retry permitido);
-- crash entre envio e update deixa 'pending' com tx enviada — fecha seguro:
-- nunca paga duas vezes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS celo_gas_drops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  amount_wei NUMERIC(30, 0) NOT NULL CHECK (amount_wei > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Um drop por conta na vida; um drop por wallet na vida (mesma wallet em
-- conta nova não bebe de novo).
CREATE UNIQUE INDEX IF NOT EXISTS idx_celo_gas_drops_profile
  ON celo_gas_drops(profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_celo_gas_drops_wallet
  ON celo_gas_drops(wallet_address);
-- Cap diário: a rota conta as linhas do dia UTC corrente.
CREATE INDEX IF NOT EXISTS idx_celo_gas_drops_created_at
  ON celo_gas_drops(created_at);

ALTER TABLE celo_gas_drops ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "celo_gas_drops_own_read" ON celo_gas_drops;
CREATE POLICY "celo_gas_drops_own_read" ON celo_gas_drops
  FOR SELECT
  USING (profile_id = auth.uid());

-- Escrita só via service_role (rota server-side) — sem policy de INSERT/UPDATE.
