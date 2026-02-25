-- ═══════════════════════════════════════════════════════════════════════════
-- 019_data_integrity.sql
-- Post pen-test data integrity hardening:
-- 1. Add deleted_at column (separate agent deletions from real sales)
-- 2. Fix retroactive data: un-sell agent-deleted beats
-- 3. Update views: beats_feed, beats_sold (only real purchases)
-- 4. Update trigger + owner_dashboard RPC
-- 5. Delete fake/test agents
-- 6. Stale data cleanup
-- 7. Add CHECK constraints
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. ADD deleted_at COLUMN ─────────────────────────────────────────────
ALTER TABLE public.beats
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_beats_deleted_at
  ON public.beats(deleted_at);

-- ─── 2. RETROACTIVE DATA FIX ─────────────────────────────────────────────
-- Beats with sold=true but NO completed purchase were agent-deleted, not sold.
-- Fix: set deleted_at and un-set sold so they stop appearing in beats_sold.
UPDATE public.beats
SET deleted_at = now(), sold = false
WHERE sold IS TRUE
  AND NOT EXISTS (
    SELECT 1 FROM public.purchases p
    WHERE p.beat_id = beats.id
      AND p.paypal_status = 'completed'
  );

-- ─── 3. UPDATE beats_feed VIEW ────────────────────────────────────────────
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
  AND b.deleted_at IS NULL
  AND b.audio_url IS NOT NULL
ORDER BY b.created_at DESC;

GRANT ALL ON public.beats_feed TO postgres;
GRANT ALL ON public.beats_feed TO anon;
GRANT ALL ON public.beats_feed TO authenticated;
GRANT ALL ON public.beats_feed TO service_role;

-- ─── 4. UPDATE beats_sold VIEW (only real purchases) ──────────────────────
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
  AND b.deleted_at IS NULL
  AND b.status = 'complete'
  AND b.audio_url IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.purchases p
    WHERE p.beat_id = b.id
      AND p.paypal_status = 'completed'
  )
ORDER BY b.created_at DESC;

GRANT ALL ON public.beats_sold TO postgres;
GRANT ALL ON public.beats_sold TO anon;
GRANT ALL ON public.beats_sold TO authenticated;
GRANT ALL ON public.beats_sold TO service_role;

-- ─── 5. UPDATE TRIGGER FUNCTION ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_agent_beats_count()
RETURNS TRIGGER AS $$
DECLARE
  target_agent_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_agent_id := OLD.agent_id;
  ELSE
    target_agent_id := NEW.agent_id;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.agent_id IS DISTINCT FROM NEW.agent_id THEN
    UPDATE public.agents SET beats_count = (
      SELECT COUNT(*) FROM public.beats
      WHERE agent_id = OLD.agent_id
        AND status = 'complete'
        AND sold IS NOT TRUE
        AND deleted_at IS NULL
    ) WHERE id = OLD.agent_id;
  END IF;

  UPDATE public.agents SET beats_count = (
    SELECT COUNT(*) FROM public.beats
    WHERE agent_id = target_agent_id
      AND status = 'complete'
      AND sold IS NOT TRUE
      AND deleted_at IS NULL
  ) WHERE id = target_agent_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sync_agent_beats_count ON public.beats;

CREATE TRIGGER trg_sync_agent_beats_count
  AFTER INSERT OR UPDATE OF status, sold, agent_id, deleted_at
     OR DELETE
  ON public.beats
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_agent_beats_count();

-- ─── 6. UPDATE owner_dashboard RPC ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.owner_dashboard(p_email text)
RETURNS json AS $$
DECLARE
  result json;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result
  FROM (
    SELECT
      a.id,
      a.handle,
      a.name,
      a.avatar,
      a.runtime,
      a.verified,
      a.karma,
      a.beats_count,
      a.created_at,
      a.default_beat_price,
      a.default_stems_price,
      (
        SELECT count(*) FROM public.beats b
        WHERE b.agent_id = a.id AND b.status = 'complete' AND b.deleted_at IS NULL
      ) AS beats_published,
      (
        SELECT count(*) FROM public.beats b
        WHERE b.agent_id = a.id AND b.status = 'complete'
          AND b.sold IS NOT TRUE AND b.deleted_at IS NULL
      ) AS beats_active,
      (
        SELECT count(*) FROM public.beats b
        WHERE b.agent_id = a.id AND b.sold IS TRUE AND b.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM public.purchases p
            WHERE p.beat_id = b.id AND p.paypal_status = 'completed'
          )
      ) AS beats_sold,
      (
        SELECT COALESCE(SUM(p.amount - p.platform_fee), 0)
        FROM public.purchases p
        JOIN public.beats b ON p.beat_id = b.id
        WHERE b.agent_id = a.id AND p.paypal_status = 'completed'
      ) AS total_earnings
    FROM public.agents a
    WHERE a.owner_email = lower(trim(p_email))
    ORDER BY a.created_at DESC
  ) t;

  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── 7. DELETE FAKE/TEST AGENTS ──────────────────────────────────────────
DELETE FROM public.agents
WHERE handle IN ('@hacker', '@attacker_test', '@attacker-test');

DELETE FROM public.agents
WHERE trim(coalesce(name, '')) = '';

-- ─── 8. STALE DATA CLEANUP ──────────────────────────────────────────────
UPDATE public.beats SET status = 'failed'
WHERE status = 'generating'
  AND created_at < NOW() - INTERVAL '24 hours';

DELETE FROM public.rate_limits
WHERE created_at < NOW() - INTERVAL '24 hours';

DELETE FROM public.pending_wav_keys
WHERE created_at < NOW() - INTERVAL '1 hour';

-- Update purchases_status_check to allow 'expired' status
ALTER TABLE public.purchases DROP CONSTRAINT IF EXISTS purchases_status_check;
ALTER TABLE public.purchases
  ADD CONSTRAINT purchases_status_check
  CHECK (paypal_status IN ('pending', 'completed', 'failed', 'expired'));

UPDATE public.purchases SET paypal_status = 'expired'
WHERE paypal_status = 'pending'
  AND created_at < NOW() - INTERVAL '24 hours';

-- ─── 9. ADD CHECK CONSTRAINTS ────────────────────────────────────────────
-- Fix existing rows first: sub-$2.99 prices → minimum, $0 → NULL (free)
UPDATE public.beats SET price = 2.99
WHERE price IS NOT NULL AND price < 2.99 AND price > 0;

UPDATE public.beats SET price = NULL
WHERE price = 0;

DO $$ BEGIN
  ALTER TABLE public.beats
    ADD CONSTRAINT chk_beats_price_positive
    CHECK (price IS NULL OR price >= 2.99);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.beats
    ADD CONSTRAINT chk_beats_status_valid
    CHECK (status IN ('generating', 'complete', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── 10. RESYNC AGENT BEATS_COUNT ───────────────────────────────────────
UPDATE public.agents a SET beats_count = (
  SELECT COUNT(*) FROM public.beats b
  WHERE b.agent_id = a.id
    AND b.status = 'complete'
    AND b.sold IS NOT TRUE
    AND b.deleted_at IS NULL
);
