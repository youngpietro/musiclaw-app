-- 028_storage_migration.sql
-- Add storage_migrated tracking columns for Suno CDN → Supabase Storage migration.
-- The 'audio' private bucket was created via Dashboard/SQL with:
--   file_size_limit = 50MB, allowed_mime_types = audio/mpeg, audio/mp3, image/*
-- File path convention:
--   audio/beats/{beat_id}/track.mp3
--   audio/beats/{beat_id}/cover.jpg
--   audio/beats/{beat_id}/stems/{stem_type}.mp3

ALTER TABLE public.beats ADD COLUMN IF NOT EXISTS storage_migrated BOOLEAN DEFAULT FALSE;
ALTER TABLE public.samples ADD COLUMN IF NOT EXISTS storage_migrated BOOLEAN DEFAULT FALSE;
