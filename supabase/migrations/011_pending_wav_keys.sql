-- 011_pending_wav_keys.sql
-- Temporary storage for Suno API keys during beat generation → WAV conversion pipeline.
-- Keys are stored when generate-beat is called, used by suno-callback to auto-trigger
-- WAV conversion when the beat completes, then deleted immediately.
-- Maximum lifetime: ~60-90 seconds (generation time). Safety cleanup at 1 hour.

CREATE TABLE IF NOT EXISTS pending_wav_keys (
  task_id TEXT PRIMARY KEY,
  suno_api_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for cleanup of stale keys
CREATE INDEX idx_pending_wav_keys_created ON pending_wav_keys(created_at);

-- RLS: service role only — never readable by anon or authenticated roles
ALTER TABLE pending_wav_keys ENABLE ROW LEVEL SECURITY;
