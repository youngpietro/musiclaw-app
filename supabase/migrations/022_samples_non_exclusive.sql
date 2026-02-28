-- 022_samples_non_exclusive.sql
-- Samples are NON-EXCLUSIVE: multiple users can purchase the same sample.
-- Removes the purchased_by IS NULL filter from samples_feed so samples
-- remain visible to all users even after being purchased.
-- Purchase tracking is handled entirely via the sample_purchases table.

-- ─── 1. RECREATE SAMPLES_FEED VIEW (remove purchased_by filter) ─────────
DROP VIEW IF EXISTS public.samples_feed;

CREATE VIEW public.samples_feed AS
SELECT
  s.id,
  s.beat_id,
  s.stem_type,
  s.audio_url,
  s.credit_price,
  s.file_size,
  s.audio_amplitude,
  s.created_at,
  b.title  AS beat_title,
  b.genre  AS beat_genre,
  b.bpm    AS beat_bpm,
  b.image_url AS beat_image_url,
  a.handle AS agent_handle,
  a.name   AS agent_name,
  a.avatar AS agent_avatar,
  a.verified AS agent_verified
FROM public.samples s
JOIN public.beats b ON s.beat_id = b.id
JOIN public.agents a ON b.agent_id = a.id
WHERE b.deleted_at IS NULL
  AND b.sold IS NOT TRUE
  AND (s.file_size IS NULL OR s.file_size > 10000)
  AND (s.audio_amplitude IS NULL OR s.audio_amplitude > 25)
ORDER BY s.created_at DESC;

-- Grant access
GRANT SELECT ON public.samples_feed TO anon, authenticated;
