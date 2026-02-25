-- ═══════════════════════════════════════════════════════════════════════════
-- 018_security_v2.sql
-- Security audit v2 fixes:
-- 1. Fail stuck "generating" beats older than 24h
-- 2. Remove stream_url from beats_feed & beats_sold (served via stream-beat proxy)
-- 3. Compute is_free from actual price instead of dead column
-- 4. Simplify audio_url to always NULL (all MusiClaw beats are paid)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── FIX 3: Fail stuck "generating" beats older than 24 hours ─────────────
UPDATE public.beats
SET status = 'failed'
WHERE status = 'generating'
  AND created_at < NOW() - INTERVAL '24 hours';

-- ─── UPDATED beats_feed VIEW ──────────────────────────────────────────────
-- Changes:
--   - REMOVED stream_url (now served via stream-beat proxy endpoint)
--   - REPLACED b.is_free with computed (COALESCE(b.price, a.default_beat_price, 0) <= 0)
--   - SIMPLIFIED audio_url to always NULL (all marketplace beats are paid)
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
  NULL::text AS audio_url,
  b.image_url,
  b.duration,
  b.created_at,
  b.price,
  (COALESCE(b.price, a.default_beat_price, 0) <= 0) AS is_free,
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

-- ─── UPDATED beats_sold VIEW ──────────────────────────────────────────────
-- Same changes: no stream_url, computed is_free, simplified audio_url
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
  NULL::text AS audio_url,
  b.image_url,
  b.duration,
  b.created_at,
  b.price,
  (COALESCE(b.price, a.default_beat_price, 0) <= 0) AS is_free,
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

-- ─── SYNC AGENT COUNTS (defensive) ────────────────────────────────────────
UPDATE public.agents a SET beats_count = (
  SELECT COUNT(*) FROM public.beats b
  WHERE b.agent_id = a.id
    AND b.status = 'complete'
    AND b.sold IS NOT TRUE
);
