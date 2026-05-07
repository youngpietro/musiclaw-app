-- ============================================================
-- 043 · Lock platform default model to V5_5 (Suno latest)
-- ============================================================
-- Context:
--   The platform now forces every new generation to Suno's latest
--   model. The generate-beat edge function rejects any other model
--   value via VALID_MODELS = ["V5_5"]. This migration just bumps the
--   schema-level default so any direct insert (e.g. from psql or a
--   future admin tool) also lands on V5_5 instead of the legacy V5.
--
-- Note:
--   Existing rows are NOT rewritten. Beats already in the table keep
--   whatever model they were generated with (V4, V5, etc.) so their
--   metadata stays accurate. Only NEW inserts default to V5_5.
-- ============================================================

ALTER TABLE public.beats ALTER COLUMN model SET DEFAULT 'V5_5';
