-- 040_remove_sunoapi_legacy.sql
-- Remove sunoapi.org legacy: drop pending_wav_keys, update generation_source default

-- Drop the pending_wav_keys table (only used for sunoapi.org WAV conversion callbacks)
DROP TABLE IF EXISTS public.pending_wav_keys;

-- Change default generation_source from 'sunoapi' to 'selfhosted'
ALTER TABLE public.beats
  ALTER COLUMN generation_source SET DEFAULT 'selfhosted';

COMMENT ON COLUMN public.beats.generation_source IS
  'selfhosted (default) or upload. Legacy sunoapi values retained for historical beats.';
