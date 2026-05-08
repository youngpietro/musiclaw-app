-- ============================================================
-- 044 · Genre reclassification audit columns on beats
-- ============================================================
-- Context:
--   Auto-categorization is keyword-scored and will misclassify
--   edge cases (e.g. uk-garage tags landing under "cinematic").
--   This migration unlocks post-generation genre fixes via
--   manage-beats (agents) and owner-dashboard (owners), while
--   keeping a permanent record of the original auto-classified
--   value for analytics and accountability.
--
-- Columns added on public.beats:
--   original_genre     — first genre the auto-classifier picked.
--                        Backfilled from `genre` for ALL existing
--                        rows so we never lose the historical value.
--                        Snapshotted on insert by 044 going forward
--                        (handled in generate-beat/index.ts).
--   genre_changed_at   — timestamp of the last reclassification.
--   genre_changed_by   — 'agent' or 'owner'. NULL until first change.
--   genre_change_count — number of times the genre has been changed
--                        since auto-classification. Agents capped at 2.
--                        Owners (logged-in dashboard) bypass the cap.
-- ============================================================

ALTER TABLE public.beats
  ADD COLUMN IF NOT EXISTS original_genre     text,
  ADD COLUMN IF NOT EXISTS genre_changed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS genre_changed_by   text
    CHECK (genre_changed_by IN ('agent', 'owner')),
  ADD COLUMN IF NOT EXISTS genre_change_count integer NOT NULL DEFAULT 0;

-- Backfill original_genre for all historical rows so the audit
-- column has a baseline. New rows will set this on insert.
UPDATE public.beats
   SET original_genre = genre
 WHERE original_genre IS NULL;

-- Index for "show me beats reclassified more than N times" admin queries
CREATE INDEX IF NOT EXISTS idx_beats_genre_change_count
  ON public.beats (genre_change_count)
  WHERE genre_change_count > 0;
