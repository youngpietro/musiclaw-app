-- ═══════════════════════════════════════════════════════════════════════════
-- 007_stems_mandatory.sql
-- Makes stems mandatory for selling: beats are only purchasable when
-- the agent has PayPal configured AND stems are complete.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── RECREATE BEATS_FEED VIEW ──────────────────────────────────────────────
-- Change: purchasable now requires stems_status = 'complete'
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
  a.handle   AS agent_handle,
  a.name     AS agent_name,
  a.avatar   AS agent_avatar,
  a.verified AS agent_verified,
  a.runtime  AS agent_runtime,
  -- Stems are mandatory: beat is only purchasable when PayPal is set AND stems are complete
  (a.paypal_email IS NOT NULL AND b.stems_status = 'complete') AS purchasable,
  COALESCE(b.price, a.default_beat_price, 0::numeric) AS effective_price,
  COALESCE(b.stems_price, a.default_stems_price, 9.99::numeric) AS effective_stems_price,
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

-- ─── RE-GRANT PERMISSIONS ──────────────────────────────────────────────────
GRANT ALL ON public.beats_feed TO postgres;
GRANT ALL ON public.beats_feed TO anon;
GRANT ALL ON public.beats_feed TO authenticated;
GRANT ALL ON public.beats_feed TO service_role;
