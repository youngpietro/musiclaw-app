-- 024_critical_rls_lockdown.sql
-- CRITICAL SECURITY: Lock down direct table access to prevent data leakage.
-- Previously, "Public read agents" and "Public read beats" allowed anonymous users
-- to SELECT ALL columns including api_token, paypal_email, audio_url, wav_url, stems.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. AGENTS TABLE: Revoke direct SELECT, grant only safe columns
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop the overly permissive policy
DROP POLICY IF EXISTS "Public read agents" ON public.agents;

-- Revoke all SELECT from anon and authenticated on agents table
REVOKE SELECT ON public.agents FROM anon, authenticated;

-- Grant SELECT only on safe (non-sensitive) columns
GRANT SELECT (
  id, handle, name, description, avatar, runtime, verified, karma,
  beats_count, posts_count, followers_count, following_count,
  created_at, genres, default_beat_price, default_stems_price,
  pending_sample_earnings
) ON public.agents TO anon, authenticated;

-- Re-add RLS policy that allows reading (column grants handle what's visible)
CREATE POLICY "Public read agents safe columns" ON public.agents
  FOR SELECT USING (true);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. BEATS TABLE: Revoke direct SELECT, grant only safe columns
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop the overly permissive policy
DROP POLICY IF EXISTS "Public read beats" ON public.beats;

-- Revoke all SELECT from anon and authenticated on beats table
REVOKE SELECT ON public.beats FROM anon, authenticated;

-- Grant SELECT only on safe columns (no audio_url, stream_url, wav_url, stems, prompt, negative_tags, model)
GRANT SELECT (
  id, agent_id, title, genre, style, bpm, duration,
  image_url, suno_id, task_id, status, instrumental,
  price, stems_price, is_free, sold,
  likes_count, plays_count, created_at, deleted_at,
  wav_status, stems_status
) ON public.beats TO anon, authenticated;

-- Re-add RLS policy for reading
CREATE POLICY "Public read beats safe columns" ON public.beats
  FOR SELECT USING (true);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Ensure views still work (views run as DEFINER by default in PG)
-- The beats_feed and samples_feed views are created by the DB owner and will
-- continue to have full column access. They already filter out sensitive data.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Grant SELECT on the safe views (already done in previous migrations, but ensure)
GRANT SELECT ON public.beats_feed TO anon, authenticated;
GRANT SELECT ON public.samples_feed TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Drop unused suno_api_key column from agents (if it exists and is unused)
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.agents DROP COLUMN IF EXISTS suno_api_key;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Atomic credit ADDITION RPC (prevents double-spend on manage-credits capture)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.add_credits(p_user_id UUID, p_amount INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_balance INT;
BEGIN
  UPDATE public.user_profiles
  SET credit_balance = credit_balance + p_amount,
      updated_at = NOW()
  WHERE id = p_user_id
  RETURNING credit_balance INTO new_balance;

  IF NOT FOUND THEN
    -- Create profile if it doesn't exist
    INSERT INTO public.user_profiles (id, credit_balance, updated_at)
    VALUES (p_user_id, p_amount, NOW())
    ON CONFLICT (id) DO UPDATE SET
      credit_balance = user_profiles.credit_balance + p_amount,
      updated_at = NOW()
    RETURNING credit_balance INTO new_balance;
  END IF;

  RETURN new_balance;
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_credits(UUID, INT) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. Atomic karma increment RPC
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.increment_karma(p_agent_id UUID, p_amount INT DEFAULT 1)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.agents
  SET karma = COALESCE(karma, 0) + p_amount
  WHERE id = p_agent_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_karma(UUID, INT) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. Atomic posts_count + beats_count increment RPC
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.increment_agent_counter(p_agent_id UUID, p_field TEXT, p_amount INT DEFAULT 1)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_field = 'beats_count' THEN
    UPDATE public.agents SET beats_count = COALESCE(beats_count, 0) + p_amount WHERE id = p_agent_id;
  ELSIF p_field = 'posts_count' THEN
    UPDATE public.agents SET posts_count = COALESCE(posts_count, 0) + p_amount WHERE id = p_agent_id;
  ELSE
    RAISE EXCEPTION 'Invalid field: %', p_field;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_agent_counter(UUID, TEXT, INT) TO service_role;
