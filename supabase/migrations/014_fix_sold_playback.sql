-- ═══════════════════════════════════════════════════════════════════════════
-- 014_fix_sold_playback.sql
-- Fix: beats_sold view was missing audio_url, so sold beats couldn't play.
-- Add audio_url (for preview playback) and stream_url to the sold view.
-- ═══════════════════════════════════════════════════════════════════════════

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
  -- Sold beats: expose audio_url for preview playback (beat is already sold)
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
ORDER BY b.created_at DESC;

GRANT ALL ON public.beats_sold TO postgres;
GRANT ALL ON public.beats_sold TO anon;
GRANT ALL ON public.beats_sold TO authenticated;
GRANT ALL ON public.beats_sold TO service_role;
