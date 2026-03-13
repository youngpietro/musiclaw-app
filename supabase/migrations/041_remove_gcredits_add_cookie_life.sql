-- ============================================================
-- 041 · Remove G-Credits System + Add Cookie Life Tracking
-- ============================================================
-- Changes:
--   1. Add cookie life tracking columns to agents table
--   2. Drop G-Credit tables (owner_gcredits, gcredit_purchases, gcredit_usage)
--   3. Drop G-Credit RPC functions
--   4. Update owner_dashboard() RPC to remove G-Credits and add cookie life
-- Context:
--   The centralized Suno API path (Option B) is being removed entirely.
--   All agents must now use their own self-hosted Suno API instance.
--   G-Credits are no longer needed. Cookie life monitoring replaces the
--   credit purchase system — owners see their Suno cookie health in the
--   dashboard and agents report it in generate-beat responses.
-- ============================================================

-- ─── 1. COOKIE LIFE TRACKING ─────────────────────────────────
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS suno_credits_left INTEGER;
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS suno_monthly_limit INTEGER;
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS suno_credits_checked_at TIMESTAMPTZ;

-- ─── 2. DROP G-CREDIT TABLES ─────────────────────────────────
-- Order matters: gcredit_usage may reference gcredit_purchases
DROP TABLE IF EXISTS public.gcredit_usage;
DROP TABLE IF EXISTS public.gcredit_purchases;
DROP TABLE IF EXISTS public.owner_gcredits;

-- ─── 3. DROP G-CREDIT RPC FUNCTIONS ──────────────────────────
DROP FUNCTION IF EXISTS public.deduct_owner_gcredits(text, integer);
DROP FUNCTION IF EXISTS public.add_owner_gcredits(text, integer);
DROP FUNCTION IF EXISTS public.deduct_gcredits(uuid, integer);
DROP FUNCTION IF EXISTS public.add_gcredits(uuid, integer);

-- ─── 4. UPDATE OWNER DASHBOARD RPC ───────────────────────────
-- Removes: g_credits, total_gcredits_spent
-- Adds:    suno_credits_left, suno_monthly_limit, suno_credits_checked_at

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

      -- Total plays across all beats
      (
        SELECT COALESCE(SUM(b.plays_count), 0) FROM public.beats b
        WHERE b.agent_id = a.id AND b.status = 'complete' AND b.deleted_at IS NULL
      ) AS total_plays,

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

      -- Recent sample sales (last 10)
      (
        SELECT COALESCE(json_agg(row_to_json(ss)), '[]'::json)
        FROM (
          SELECT sp.created_at, sp.agent_earning, sp.credits_spent,
                 s.stem_type, b.title as beat_title
          FROM public.sample_purchases sp
          JOIN public.samples s ON sp.sample_id = s.id
          JOIN public.beats b ON s.beat_id = b.id
          WHERE b.agent_id = a.id
          ORDER BY sp.created_at DESC
          LIMIT 10
        ) ss
      ) AS recent_sample_sales,

      -- Self-hosted config
      a.suno_self_hosted_url,

      -- Pro plan verification
      COALESCE(a.suno_plan_verified, false) AS suno_plan_verified,
      a.suno_plan_type,
      a.suno_plan_verified_at,

      -- Cookie life tracking
      a.suno_credits_left,
      a.suno_monthly_limit,
      a.suno_credits_checked_at

    FROM public.agents a
    WHERE a.owner_email = lower(trim(p_email))
    ORDER BY a.created_at DESC
  ) t;

  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.owner_dashboard(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.owner_dashboard(text) TO service_role;
