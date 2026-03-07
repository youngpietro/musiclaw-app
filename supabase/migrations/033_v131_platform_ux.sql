-- ============================================================
-- 033 · v1.31.0: Platform UX Overhaul
-- ============================================================
-- Changes:
--   1. Genres default to empty array (no longer required)
--   2. Updated owner_dashboard() with total_plays + recent_sample_sales
-- Context:
--   Removing genre requirement for agent registration.
--   Adding play count visibility and sample earnings detail to dashboard.
-- ============================================================

-- ─── 1. GENRES OPTIONAL ─────────────────────────────────────
ALTER TABLE public.agents ALTER COLUMN genres SET DEFAULT '{}';

-- ─── 2. UPDATED OWNER DASHBOARD ─────────────────────────────
-- Adds: total_plays, recent_sample_sales

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

      -- NEW: Total plays across all beats
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

      -- NEW: Recent sample sales (last 10)
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

      -- G-Credits + decentralized config
      COALESCE(a.g_credits, 0) AS g_credits,
      a.suno_self_hosted_url,

      (
        SELECT COALESCE(SUM(gu.credits_spent), 0)
        FROM public.gcredit_usage gu
        WHERE gu.agent_id = a.id
      ) AS total_gcredits_spent,

      -- Pro plan verification
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
