-- ============================================================
-- 046 · Payout Retry Cron
-- ============================================================
-- Schedules a nightly call to the retry-failed-payouts edge
-- function. Uses pg_cron + pg_net (both are pre-installed on
-- Supabase; we just need to enable them).
--
-- The cron runs once a day at 04:00 UTC. retry-failed-payouts has
-- its own internal MIN_AGE_MINUTES guard so it won't hammer rows
-- that were just attempted.
--
-- Two settings must be configured in Supabase Vault before the cron
-- works (these never appear in source — set via the Supabase dash):
--   - app.retry_payouts_url      → https://<project>.supabase.co/functions/v1/retry-failed-payouts
--   - app.retry_payouts_secret   → matches PAYOUT_RETRY_CRON_SECRET env on the edge function
--
-- IF YOU SKIP CONFIGURING THESE: the cron job exists but the HTTP
-- call inside it will return 401 from the edge function, which is
-- safe — no payouts will be attempted from an unauthenticated cron.
-- ============================================================

-- ─── 1. ENSURE EXTENSIONS ────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ─── 2. WRAPPER FUNCTION ─────────────────────────────────────
-- Indirection so we can swap the URL or auth header without
-- having to delete + re-create the cron job.
CREATE OR REPLACE FUNCTION public.cron_retry_failed_payouts()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_url TEXT;
  v_secret TEXT;
  v_request_id BIGINT;
BEGIN
  -- Read settings (configured via ALTER DATABASE ... SET app.retry_payouts_url = ...
  -- or via Supabase Vault). current_setting(..., true) returns NULL when missing
  -- instead of erroring, so we can fail gracefully.
  v_url := current_setting('app.retry_payouts_url', true);
  v_secret := current_setting('app.retry_payouts_secret', true);

  IF v_url IS NULL OR v_url = '' THEN
    RAISE NOTICE 'cron_retry_failed_payouts: app.retry_payouts_url not configured, skipping';
    RETURN 0;
  END IF;

  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Retry-Source', 'cron',
      'X-Cron-Secret', COALESCE(v_secret, '')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cron_retry_failed_payouts() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cron_retry_failed_payouts() TO postgres, service_role;

-- ─── 3. SCHEDULE NIGHTLY ─────────────────────────────────────
-- Unschedule any prior version before re-creating, so this migration
-- is idempotent.
DO $$
BEGIN
  PERFORM cron.unschedule('retry-failed-payouts-nightly');
EXCEPTION WHEN OTHERS THEN
  -- job didn't exist yet — fine.
  NULL;
END $$;

SELECT cron.schedule(
  'retry-failed-payouts-nightly',
  '0 4 * * *',  -- 04:00 UTC every day
  $$ SELECT public.cron_retry_failed_payouts(); $$
);
