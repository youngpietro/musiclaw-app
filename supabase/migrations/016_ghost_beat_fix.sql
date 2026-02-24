-- ═══════════════════════════════════════════════════════════════════════════
-- 016_ghost_beat_fix.sql
-- Bulletproof ghost beat prevention:
-- 1. Trigger to auto-sync agents.beats_count from actual complete beats
-- 2. Add audio_url IS NOT NULL guard to beats_feed and beats_sold views
-- 3. One-time fix: sync all agents' beats_count to reality
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── TRIGGER FUNCTION: sync_agent_beats_count ────────────────────────────
-- Recomputes agents.beats_count from actual COUNT of complete, unsold beats.
-- Fires on INSERT, UPDATE (of status/sold/agent_id), DELETE on beats table.

CREATE OR REPLACE FUNCTION public.sync_agent_beats_count()
RETURNS TRIGGER AS $$
DECLARE
  target_agent_id UUID;
BEGIN
  -- Determine which agent to update
  IF TG_OP = 'DELETE' THEN
    target_agent_id := OLD.agent_id;
  ELSE
    target_agent_id := NEW.agent_id;
  END IF;

  -- Handle agent_id change (defensive)
  IF TG_OP = 'UPDATE' AND OLD.agent_id IS DISTINCT FROM NEW.agent_id THEN
    UPDATE public.agents SET beats_count = (
      SELECT COUNT(*) FROM public.beats
      WHERE agent_id = OLD.agent_id
        AND status = 'complete'
        AND sold IS NOT TRUE
    ) WHERE id = OLD.agent_id;
  END IF;

  -- Recompute count for the target agent
  UPDATE public.agents SET beats_count = (
    SELECT COUNT(*) FROM public.beats
    WHERE agent_id = target_agent_id
      AND status = 'complete'
      AND sold IS NOT TRUE
  ) WHERE id = target_agent_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── TRIGGER ─────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_sync_agent_beats_count ON public.beats;

CREATE TRIGGER trg_sync_agent_beats_count
  AFTER INSERT OR UPDATE OF status, sold, agent_id
     OR DELETE
  ON public.beats
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_agent_beats_count();

-- ─── UPDATED beats_feed VIEW (add audio_url guard) ──────────────────────
DROP VIEW IF EXISTS public.beats_feed;

CREATE VIEW public.beats_feed AS
SELECT
  b.id,
  b.title,
  b.genre,
  b.style,
  b.bpm,
  b.model,
  b.status,
  CASE WHEN b.price IS NOT NULL AND b.price > 0 THEN NULL ELSE b.audio_url END AS audio_url,
  b.image_url,
  b.duration,
  b.created_at,
  b.price,
  b.is_free,
  b.stream_url,
  b.suno_id,
  b.likes_count,
  b.plays_count,
  b.wav_status,
  b.stems_status,
  b.stems_price,
  COALESCE(b.sold, false) AS sold,
  a.handle   AS agent_handle,
  a.name     AS agent_name,
  a.avatar   AS agent_avatar,
  a.verified AS agent_verified,
  a.runtime  AS agent_runtime,
  (a.paypal_email IS NOT NULL AND COALESCE(b.sold, false) IS NOT TRUE) AS purchasable,
  COALESCE(b.price, a.default_beat_price, 0::numeric) AS effective_price,
  COALESCE(b.stems_price, a.default_stems_price, 9.99::numeric) AS effective_stems_price
FROM beats b
JOIN agents a ON b.agent_id = a.id
WHERE b.status = 'complete'
  AND b.sold IS NOT TRUE
  AND b.audio_url IS NOT NULL
ORDER BY b.created_at DESC;

GRANT ALL ON public.beats_feed TO postgres;
GRANT ALL ON public.beats_feed TO anon;
GRANT ALL ON public.beats_feed TO authenticated;
GRANT ALL ON public.beats_feed TO service_role;

-- ─── UPDATED beats_sold VIEW (add audio_url guard) ──────────────────────
DROP VIEW IF EXISTS public.beats_sold;

CREATE VIEW public.beats_sold AS
SELECT
  b.id,
  b.title,
  b.genre,
  b.style,
  b.bpm,
  b.model,
  b.status,
  b.audio_url,
  b.image_url,
  b.duration,
  b.created_at,
  b.price,
  b.is_free,
  b.stream_url,
  b.suno_id,
  b.likes_count,
  b.plays_count,
  b.wav_status,
  b.stems_status,
  b.stems_price,
  true AS sold,
  a.handle   AS agent_handle,
  a.name     AS agent_name,
  a.avatar   AS agent_avatar,
  a.verified AS agent_verified,
  a.runtime  AS agent_runtime,
  false AS purchasable,
  COALESCE(b.price, a.default_beat_price, 0::numeric) AS effective_price,
  COALESCE(b.stems_price, a.default_stems_price, 9.99::numeric) AS effective_stems_price
FROM beats b
JOIN agents a ON b.agent_id = a.id
WHERE b.sold IS TRUE
  AND b.status = 'complete'
  AND b.audio_url IS NOT NULL
ORDER BY b.created_at DESC;

GRANT ALL ON public.beats_sold TO postgres;
GRANT ALL ON public.beats_sold TO anon;
GRANT ALL ON public.beats_sold TO authenticated;
GRANT ALL ON public.beats_sold TO service_role;

-- ─── ONE-TIME FIX: sync ALL agents' beats_count to reality ──────────────
UPDATE public.agents a SET beats_count = (
  SELECT COUNT(*) FROM public.beats b
  WHERE b.agent_id = a.id
    AND b.status = 'complete'
    AND b.sold IS NOT TRUE
);
