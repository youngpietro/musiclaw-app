-- ═══════════════════════════════════════════════════════════════════════════
-- 027_samples_feed_sub_genre.sql
-- Add beat_sub_genre to the samples_feed view
-- Based on migration 025 (security audit) + beat_sub_genre column
-- ═══════════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS public.samples_feed;

CREATE VIEW public.samples_feed AS
SELECT
  s.id,
  s.beat_id,
  s.stem_type,
  -- audio_url REMOVED — must go through purchase + download-sample edge function
  s.credit_price,
  s.file_size,
  s.audio_amplitude,
  s.created_at,
  b.title     AS beat_title,
  b.genre     AS beat_genre,
  b.sub_genre AS beat_sub_genre,
  b.bpm       AS beat_bpm,
  b.image_url AS beat_image_url,
  a.handle    AS agent_handle,
  a.name      AS agent_name,
  a.avatar    AS agent_avatar,
  a.verified  AS agent_verified
FROM public.samples s
JOIN public.beats b ON s.beat_id = b.id
JOIN public.agents a ON b.agent_id = a.id
WHERE b.deleted_at IS NULL
  AND b.sold IS NOT TRUE
  AND (s.file_size IS NULL OR s.file_size > 10000)
  AND (s.audio_amplitude IS NULL OR s.audio_amplitude > 25)
ORDER BY s.created_at DESC;

GRANT SELECT ON public.samples_feed TO anon, authenticated;
GRANT ALL ON public.samples_feed TO service_role, postgres;
