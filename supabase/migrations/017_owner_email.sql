-- ═══════════════════════════════════════════════════════════════════════════
-- 017_owner_email.sql
-- 1. Add owner_email to agents table (human identity for agent owners)
-- 2. Create owner_dashboard RPC for fetching agent stats by owner email
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── ADD OWNER EMAIL COLUMN ─────────────────────────────────────────────
-- Nullable for existing agents. New registrations enforce it at edge function level.
-- No UNIQUE constraint — one human can own multiple agents.
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS owner_email text;

CREATE INDEX IF NOT EXISTS idx_agents_owner_email
  ON public.agents(owner_email);

-- ─── OWNER DASHBOARD RPC ────────────────────────────────────────────────
-- Returns JSON array of agents + beat stats for a verified owner email.
-- Called by the owner-dashboard edge function after email verification.

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
      (
        SELECT count(*) FROM public.beats b
        WHERE b.agent_id = a.id AND b.status = 'complete'
      ) AS beats_published,
      (
        SELECT count(*) FROM public.beats b
        WHERE b.agent_id = a.id AND b.status = 'complete' AND b.sold IS NOT TRUE
      ) AS beats_active,
      (
        SELECT count(*) FROM public.beats b
        WHERE b.agent_id = a.id AND b.sold IS TRUE
      ) AS beats_sold,
      (
        SELECT COALESCE(SUM(p.amount - p.platform_fee), 0)
        FROM public.purchases p
        JOIN public.beats b ON p.beat_id = b.id
        WHERE b.agent_id = a.id AND p.paypal_status = 'completed'
      ) AS total_earnings
    FROM public.agents a
    WHERE a.owner_email = lower(trim(p_email))
    ORDER BY a.created_at DESC
  ) t;

  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
