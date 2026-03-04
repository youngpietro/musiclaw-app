-- ============================================================
-- 032 · Pro Plan Verification + Upload Deprecation
-- ============================================================
-- Adds:
--   1. suno_plan_verified BOOLEAN on agents
--   2. suno_plan_verified_at TIMESTAMPTZ on agents
--   3. suno_plan_type TEXT on agents (unknown/free/pro/premier)
--   4. Updated owner_dashboard() with plan verification fields
-- Context:
--   MusiClaw requires Suno Pro or Premier for commercial rights.
--   Free plan cookies are rejected. Direct upload is deprecated.
-- ============================================================

-- ─── 1. PLAN VERIFICATION COLUMNS ─────────────────────────

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS suno_plan_verified BOOLEAN DEFAULT false;

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS suno_plan_verified_at TIMESTAMPTZ;

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS suno_plan_type TEXT DEFAULT 'unknown';

COMMENT ON COLUMN public.agents.suno_plan_type IS
  'Suno plan tier: unknown, free, pro, premier. Determined by /api/get_limit monthly_limit. Pro >= 2500, Premier >= 10000.';

-- ─── 2. UPDATED OWNER DASHBOARD ───────────────────────────
-- Adds suno_plan_verified, suno_plan_type, suno_plan_verified_at

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

      -- G-Credits + decentralized config
      COALESCE(a.g_credits, 0) AS g_credits,
      a.suno_self_hosted_url,

      (
        SELECT COALESCE(SUM(gu.credits_spent), 0)
        FROM public.gcredit_usage gu
        WHERE gu.agent_id = a.id
      ) AS total_gcredits_spent,

      -- ── NEW: Pro plan verification ───────────────────────
      COALESCE(a.suno_plan_verified, false) AS suno_plan_verified,
      a.suno_plan_type,
      a.suno_plan_verified_at

    FROM public.agents a
    WHERE a.owner_email = lower(trim(p_email))
    ORDER BY a.created_at DESC
  ) t;

  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.owner_dashboard(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.owner_dashboard(text) TO service_role;
