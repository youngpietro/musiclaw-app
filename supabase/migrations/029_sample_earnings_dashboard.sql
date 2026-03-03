-- ============================================================
-- 029 · Sample Earnings Dashboard + Payout System
-- ============================================================
-- Adds:
--   1. sample_payouts table — tracks payout requests for sample earnings
--   2. process_sample_payout() RPC — atomic balance deduction
--   3. Updated owner_dashboard() — now includes sample earnings data
-- ============================================================

-- ─── 1. SAMPLE PAYOUTS TABLE ────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sample_payouts (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID          NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  owner_email  TEXT          NOT NULL,
  amount       NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  paypal_email TEXT          NOT NULL,
  paypal_batch_id TEXT,
  status       TEXT          NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','sent','failed','error')),
  created_at   TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sample_payouts_agent_id
  ON public.sample_payouts(agent_id);

CREATE INDEX IF NOT EXISTS idx_sample_payouts_owner_email
  ON public.sample_payouts(lower(owner_email));

ALTER TABLE public.sample_payouts ENABLE ROW LEVEL SECURITY;

-- No direct user access — only service_role (via edge functions)
GRANT ALL ON public.sample_payouts TO service_role;


-- ─── 2. ATOMIC PAYOUT RPC ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.process_sample_payout(
  p_agent_id UUID,
  p_amount   NUMERIC
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rows_affected INT;
BEGIN
  UPDATE public.agents
  SET pending_sample_earnings = pending_sample_earnings - p_amount
  WHERE id = p_agent_id
    AND pending_sample_earnings >= p_amount;

  GET DIAGNOSTICS rows_affected = ROW_COUNT;

  RETURN rows_affected > 0;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_sample_payout(UUID, NUMERIC) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.process_sample_payout(UUID, NUMERIC) TO service_role;


-- ─── 3. UPDATED OWNER DASHBOARD RPC ─────────────────────────

CREATE OR REPLACE FUNCTION public.owner_dashboard(p_email text)
RETURNS json AS $$
DECLARE
  result json;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result
  FROM (
    SELECT
      a.id,
      a.handle,
      a.name,
      a.avatar,
      a.runtime,
      a.verified,
      a.karma,
      a.beats_count,
      a.created_at,
      a.default_beat_price,
      a.default_stems_price,
      a.paypal_email,

      -- Beat stats (unchanged)
      (
        SELECT count(*) FROM public.beats b
        WHERE b.agent_id = a.id AND b.status = 'complete' AND b.deleted_at IS NULL
      ) AS beats_published,

      (
        SELECT count(*) FROM public.beats b
        WHERE b.agent_id = a.id AND b.status = 'complete'
          AND b.sold IS NOT TRUE AND b.deleted_at IS NULL
      ) AS beats_active,

      (
        SELECT count(*) FROM public.beats b
        WHERE b.agent_id = a.id AND b.sold IS TRUE AND b.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM public.purchases p
            WHERE p.beat_id = b.id AND p.paypal_status = 'completed'
          )
      ) AS beats_sold,

      (
        SELECT COALESCE(SUM(p.amount - p.platform_fee), 0)
        FROM public.purchases p
        JOIN public.beats b ON p.beat_id = b.id
        WHERE b.agent_id = a.id AND p.paypal_status = 'completed'
      ) AS total_earnings,

      -- ── NEW: Sample earnings data ──────────────────────────
      COALESCE(a.pending_sample_earnings, 0) AS pending_sample_earnings,

      (
        SELECT count(*)
        FROM public.sample_purchases sp
        JOIN public.samples s ON sp.sample_id = s.id
        JOIN public.beats  b  ON s.beat_id   = b.id
        WHERE b.agent_id = a.id
      ) AS samples_sold,

      (
        SELECT COALESCE(SUM(sp.agent_earning), 0)
        FROM public.sample_purchases sp
        JOIN public.samples s ON sp.sample_id = s.id
        JOIN public.beats  b  ON s.beat_id   = b.id
        WHERE b.agent_id = a.id
      ) AS total_sample_revenue

    FROM public.agents a
    WHERE a.owner_email = lower(trim(p_email))
    ORDER BY a.created_at DESC
  ) t;

  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Permissions (idempotent)
REVOKE EXECUTE ON FUNCTION public.owner_dashboard(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.owner_dashboard(text) TO service_role;
