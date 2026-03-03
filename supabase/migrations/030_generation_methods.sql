-- ============================================================
-- 030 · Three Beat Generation Methods
-- ============================================================
-- Adds support for three ways to create beats:
--   1. sunoapi.org (existing, unchanged)
--   2. Self-hosted gcui-art/suno-api (agent provides Suno cookie)
--   3. Direct upload (agent uploads pre-made beat via URL)
-- ============================================================

-- ─── 1. AGENT SUNO COOKIE ───────────────────────────────────
-- Stores the agent's Suno Pro session cookie for self-hosted generation.
-- Nullable — only set when agent uses self-hosted method.
-- NOT exposed to anon/authenticated (service_role only via edge functions).

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS suno_cookie TEXT;


-- ─── 2. BEAT GENERATION SOURCE TRACKING ─────────────────────
-- Tracks how each beat was created for analytics, debugging, and routing.
-- Defaults to 'sunoapi' for all existing beats.

ALTER TABLE public.beats
  ADD COLUMN IF NOT EXISTS generation_source TEXT DEFAULT 'sunoapi';

COMMENT ON COLUMN public.beats.generation_source IS
  'How this beat was created: sunoapi (sunoapi.org), selfhosted (gcui-art/suno-api), upload (direct upload)';


-- ─── 3. UPDATE COLUMN-LEVEL GRANTS ──────────────────────────
-- beats: add generation_source to the safe columns list
-- (Replaces the grant from 026_sub_genres.sql line 231-237)

REVOKE SELECT ON public.beats FROM anon, authenticated;

GRANT SELECT (
  id, agent_id, title, genre, sub_genre, style, bpm, duration,
  image_url, suno_id, task_id, status, instrumental,
  price, stems_price, is_free, sold, generation_source,
  likes_count, plays_count, created_at, deleted_at,
  wav_status, stems_status
) ON public.beats TO anon, authenticated;

-- Re-create RLS policy (idempotent)
DROP POLICY IF EXISTS "Public read beats safe columns" ON public.beats;
CREATE POLICY "Public read beats safe columns" ON public.beats
  FOR SELECT USING (true);

-- Note: suno_cookie is intentionally NOT granted to anon/authenticated.
-- The agents table column grants from 024/026 already exclude it since
-- they use explicit column lists. No additional REVOKE needed.
