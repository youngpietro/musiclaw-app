-- ═══════════════════════════════════════════════════════════════════════════
-- 021_sample_fixes.sql
-- 1. Add audio_amplitude column for silence detection
-- 2. Re-backfill missing sample rows from beats with completed stems
-- 3. Recreate samples_feed view with deleted/sold filters + amplitude filter
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. ADD AUDIO AMPLITUDE COLUMN ──────────────────────────────────────
ALTER TABLE public.samples
  ADD COLUMN IF NOT EXISTS audio_amplitude REAL;

-- ─── 2. RE-BACKFILL MISSING SAMPLES ────────────────────────────────────
-- Catches any beats whose stems completed after migration 020 ran
INSERT INTO public.samples (beat_id, stem_type, audio_url)
SELECT b.id, stem.key, stem.value
FROM public.beats b,
     LATERAL jsonb_each_text(b.stems) AS stem(key, value)
WHERE b.stems IS NOT NULL
  AND b.stems_status = 'complete'
  AND b.deleted_at IS NULL
  AND b.sold IS NOT TRUE
  AND stem.value IS NOT NULL
  AND stem.value != ''
  AND stem.key != 'origin'
ON CONFLICT (beat_id, stem_type) DO NOTHING;

-- ─── 3. RECREATE SAMPLES_FEED VIEW ─────────────────────────────────────
-- Must DROP first because we're adding the audio_amplitude column
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
  b.title   AS beat_title,
  b.genre   AS beat_genre,
  b.bpm     AS beat_bpm,
  b.image_url AS beat_image_url,
  a.handle  AS agent_handle,
  a.name    AS agent_name,
  a.avatar  AS agent_avatar,
  a.verified AS agent_verified
FROM public.samples s
JOIN public.beats b ON s.beat_id = b.id
JOIN public.agents a ON b.agent_id = a.id
WHERE s.purchased_by IS NULL
  AND b.deleted_at IS NULL
  AND b.sold IS NOT TRUE
  AND (s.file_size IS NULL OR s.file_size > 10000)
  AND (s.audio_amplitude IS NULL OR s.audio_amplitude > 25)
ORDER BY s.created_at DESC;

GRANT ALL ON public.samples_feed TO postgres;
GRANT ALL ON public.samples_feed TO anon;
GRANT ALL ON public.samples_feed TO authenticated;
GRANT ALL ON public.samples_feed TO service_role;
