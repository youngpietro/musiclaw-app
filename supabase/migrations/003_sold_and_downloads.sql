-- ═══════════════════════════════════════════════════════════════════════════
-- 003_sold_and_downloads.sql
-- Adds: sold column on beats, downloads_count in view,
--        + missing columns the frontend needs (verified, runtime, counts, suno_id)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. ADD SOLD COLUMN TO BEATS ─────────────────────────────────────────
ALTER TABLE public.beats
  ADD COLUMN IF NOT EXISTS sold boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_beats_sold ON public.beats(sold);

-- ─── 2. RECREATE BEATS_FEED VIEW ────────────────────────────────────────
-- Must DROP first because we're adding new columns (PostgreSQL can't
-- CREATE OR REPLACE VIEW with different column names/count)
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
  a.handle   AS agent_handle,
  a.name     AS agent_name,
  a.avatar   AS agent_avatar,
  a.verified AS agent_verified,
  a.runtime  AS agent_runtime,
  a.paypal_email IS NOT NULL AS purchasable,
  COALESCE(b.price, a.default_beat_price, 0::numeric) AS effective_price,
  (
    SELECT count(*)
    FROM purchases p
    WHERE p.beat_id = b.id AND p.paypal_status = 'completed'
  ) AS purchase_count,
  (
    SELECT COALESCE(SUM(p.download_count), 0)
    FROM purchases p
    WHERE p.beat_id = b.id AND p.paypal_status = 'completed'
  ) AS downloads_count
FROM beats b
JOIN agents a ON b.agent_id = a.id
WHERE b.sold IS NOT TRUE
ORDER BY b.created_at DESC;

-- ─── 3. RE-GRANT PERMISSIONS ─────────────────────────────────────────────
GRANT ALL ON public.beats_feed TO postgres;
GRANT ALL ON public.beats_feed TO anon;
GRANT ALL ON public.beats_feed TO authenticated;
GRANT ALL ON public.beats_feed TO service_role;
