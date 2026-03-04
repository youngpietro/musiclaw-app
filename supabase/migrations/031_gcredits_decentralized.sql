-- ============================================================
-- 031 · G-Credits System + Decentralized Self-Hosted
-- ============================================================
-- Adds:
--   1. Per-agent self-hosted Suno API URL (decentralized)
--   2. G-Credits balance on agents (for centralized instance usage)
--   3. gcredit_purchases table (PayPal purchase history)
--   4. gcredit_usage table (deduction ledger)
--   5. Atomic RPCs: deduct_gcredits, add_gcredits
--   6. Updated owner_dashboard() with G-Credits + self-hosted URL
-- ============================================================

-- ─── 1. PER-AGENT SELF-HOSTED URL ────────────────────────────
-- Agents can host their own gcui-art/suno-api instance.
-- If set, generate-beat uses this URL instead of the centralized one.
-- No G-Credits charged when using your own instance.

ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS suno_self_hosted_url TEXT;

-- ─── 2. G-CREDITS BALANCE ────────────────────────────────────
-- $5 USD = 50 G-Credits. 1 credit = 1 generation (2 beats) or 1 stems call.
-- Only charged when using MusiClaw's centralized self-hosted instance.

ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS g_credits INTEGER DEFAULT 0;

-- ─── 3. G-CREDIT PURCHASES TABLE ─────────────────────────────

CREATE TABLE IF NOT EXISTS public.gcredit_purchases (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID          NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  credits_amount  INTEGER       NOT NULL,
  amount_usd      NUMERIC(10,2) NOT NULL,
  paypal_order_id TEXT,
  paypal_capture_id TEXT,
  paypal_status   TEXT          DEFAULT 'pending'
                                CHECK (paypal_status IN ('pending','completed','failed')),
  created_at      TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gcredit_purchases_agent_id
  ON public.gcredit_purchases(agent_id);

ALTER TABLE public.gcredit_purchases ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.gcredit_purchases TO service_role;

-- ─── 4. G-CREDIT USAGE LEDGER ────────────────────────────────

CREATE TABLE IF NOT EXISTS public.gcredit_usage (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       UUID          NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  action         TEXT          NOT NULL CHECK (action IN ('generate','stems')),
  credits_spent  INTEGER       NOT NULL DEFAULT 1,
  beat_id        UUID          REFERENCES public.beats(id),
  created_at     TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gcredit_usage_agent_id
  ON public.gcredit_usage(agent_id);

ALTER TABLE public.gcredit_usage ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.gcredit_usage TO service_role;

-- ─── 5. ATOMIC RPCs ──────────────────────────────────────────

-- Deduct G-Credits (fails if insufficient balance)
CREATE OR REPLACE FUNCTION public.deduct_gcredits(
  p_agent_id UUID,
  p_amount   INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_balance INTEGER;
BEGIN
  UPDATE public.agents
  SET g_credits = g_credits - p_amount
  WHERE id = p_agent_id
    AND g_credits >= p_amount
  RETURNING g_credits INTO new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient G-Credits (need %, have less)', p_amount;
  END IF;

  RETURN new_balance;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.deduct_gcredits(UUID, INTEGER) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.deduct_gcredits(UUID, INTEGER) TO service_role;

-- Add G-Credits (after PayPal capture)
CREATE OR REPLACE FUNCTION public.add_gcredits(
  p_agent_id UUID,
  p_amount   INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_balance INTEGER;
BEGIN
  UPDATE public.agents
  SET g_credits = g_credits + p_amount
  WHERE id = p_agent_id
  RETURNING g_credits INTO new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent not found';
  END IF;

  RETURN new_balance;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_gcredits(UUID, INTEGER) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.add_gcredits(UUID, INTEGER) TO service_role;

-- ─── 6. UPDATED OWNER DASHBOARD ──────────────────────────────
-- Adds g_credits, suno_self_hosted_url, total_gcredits_spent

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

      -- Beat stats
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

      -- Sample earnings
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
      ) AS total_sample_revenue,

      -- ── NEW: G-Credits + decentralized config ───────────
      COALESCE(a.g_credits, 0) AS g_credits,
      a.suno_self_hosted_url,

      (
        SELECT COALESCE(SUM(gu.credits_spent), 0)
        FROM public.gcredit_usage gu
        WHERE gu.agent_id = a.id
      ) AS total_gcredits_spent

    FROM public.agents a
    WHERE a.owner_email = lower(trim(p_email))
    ORDER BY a.created_at DESC
  ) t;

  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.owner_dashboard(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.owner_dashboard(text) TO service_role;
