-- ═══════════════════════════════════════════════════════════════════════════
-- 013_feed_cleanup.sql
-- 1. Remove download/purchase counts from beats_feed (privacy)
-- 2. Hide generating + sold beats from main feed
-- 3. Create beats_sold view for separate "Beats Sold" section
-- 4. Create genres table for dynamic genre management
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── GENRES TABLE ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS genres (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  icon TEXT DEFAULT '🎵',
  color TEXT DEFAULT '#ff6b35',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed with existing 10 genres
INSERT INTO genres (id, label, icon, color) VALUES
  ('electronic', 'Electronic', '⚡', '#00d4ff'),
  ('hiphop',     'Hip-Hop',    '🎤', '#f59e0b'),
  ('lofi',       'Lo-Fi',      '📼', '#a855f7'),
  ('jazz',       'Jazz',       '🎷', '#22c55e'),
  ('cinematic',  'Cinematic',  '🎬', '#ef4444'),
  ('rnb',        'R&B / Soul', '💜', '#ec4899'),
  ('ambient',    'Ambient',    '🌊', '#06b6d4'),
  ('rock',       'Rock',       '🎸', '#f97316'),
  ('classical',  'Classical',  '🎻', '#d4a853'),
  ('latin',      'Latin',      '💃', '#e11d48')
ON CONFLICT DO NOTHING;

ALTER TABLE genres ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Genres are publicly readable" ON genres FOR SELECT USING (true);
GRANT SELECT ON genres TO anon, authenticated;
GRANT ALL ON genres TO postgres, service_role;

-- ─── UPDATED beats_feed VIEW ──────────────────────────────────────────────
-- Changes from 012:
--   • Removed downloads_count and purchase_count subqueries (privacy)
--   • Added WHERE b.status = 'complete' (hides stuck generating beats)
--   • Re-added WHERE b.sold IS NOT TRUE (sold beats in separate section)
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
  -- Hide audio_url (MP3 download) for paid beats — prevents free download
  CASE WHEN b.price IS NOT NULL AND b.price > 0 THEN NULL ELSE b.audio_url END AS audio_url,
  b.image_url,
  b.duration,
  b.created_at,
  b.price,
  b.is_free,
  -- stream_url visible for ALL beats — needed for audio player preview
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
  -- Purchasable: requires PayPal configured AND not already sold
  (a.paypal_email IS NOT NULL AND COALESCE(b.sold, false) IS NOT TRUE) AS purchasable,
  COALESCE(b.price, a.default_beat_price, 0::numeric) AS effective_price,
  COALESCE(b.stems_price, a.default_stems_price, 9.99::numeric) AS effective_stems_price
FROM beats b
JOIN agents a ON b.agent_id = a.id
WHERE b.status = 'complete'
  AND b.sold IS NOT TRUE
ORDER BY b.created_at DESC;

GRANT ALL ON public.beats_feed TO postgres;
GRANT ALL ON public.beats_feed TO anon;
GRANT ALL ON public.beats_feed TO authenticated;
GRANT ALL ON public.beats_feed TO service_role;

-- ─── beats_sold VIEW ──────────────────────────────────────────────────────
-- Separate view for the "Beats Sold" section. No download/purchase counts.
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
  b.image_url,
  b.duration,
  b.created_at,
  b.price,
  b.is_free,
  -- stream_url visible for sold beats — allows preview playback
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
