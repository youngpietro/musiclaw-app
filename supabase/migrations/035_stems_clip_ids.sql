-- 035: Add stems_clip_ids column for self-hosted stem polling
-- Stores the Suno clip IDs for stem clips during async processing
-- Used by process-stems and poll-stems to track and poll stem completion

ALTER TABLE public.beats
  ADD COLUMN IF NOT EXISTS stems_clip_ids TEXT[] DEFAULT '{}';

COMMENT ON COLUMN public.beats.stems_clip_ids IS 'Suno clip IDs for stem tracks, used for polling self-hosted stems completion';
