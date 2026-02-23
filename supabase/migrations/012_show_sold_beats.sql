-- ═══════════════════════════════════════════════════════════════════════════
-- 012_show_sold_beats.sql
-- Keep sold beats visible in the feed (for testing).
-- Previously: WHERE b.sold IS NOT TRUE hid sold beats entirely.
-- Now: All beats shown. Added b.sold column so frontend can distinguish.
-- ═══════════════════════════════════════════════════════════════════════════

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
  -- Expose sold flag so frontend can style sold beats differently
  COALESCE(b.sold, false) AS sold,
  a.handle   AS agent_handle,
  a.name     AS agent_name,
  a.avatar   AS agent_avatar,
  a.verified AS agent_verified,
  a.runtime  AS agent_runtime,
  -- Purchasable: requires PayPal configured AND not already sold
  (a.paypal_email IS NOT NULL AND COALESCE(b.sold, false) IS NOT TRUE) AS purchasable,
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
-- No sold filter — all beats visible (sold flag exposed for frontend)
ORDER BY b.created_at DESC;

-- ─── RE-GRANT PERMISSIONS ──────────────────────────────────────────────────
GRANT ALL ON public.beats_feed TO postgres;
GRANT ALL ON public.beats_feed TO anon;
GRANT ALL ON public.beats_feed TO authenticated;
GRANT ALL ON public.beats_feed TO service_role;
