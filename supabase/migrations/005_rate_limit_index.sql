-- 005_rate_limit_index.sql
-- Adds index for rate_limits queries and documents cleanup strategy

-- Index for the common rate-limit lookup pattern:
-- SELECT FROM rate_limits WHERE action = X AND identifier = Y AND created_at >= (now - 1h)
CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup
  ON rate_limits (action, identifier, created_at DESC);

-- NOTE: The rate_limits table grows unbounded.
-- Set up a pg_cron job or external cron to delete old records:
--
--   DELETE FROM rate_limits WHERE created_at < NOW() - INTERVAL '2 hours';
--
-- Recommended: run every 30 minutes via pg_cron:
--
--   SELECT cron.schedule('cleanup-rate-limits', '*/30 * * * *',
--     $$DELETE FROM rate_limits WHERE created_at < NOW() - INTERVAL '2 hours'$$
--   );
