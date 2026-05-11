-- ============================================================
-- 047 · Cron Secret via Supabase Vault
-- ============================================================
-- Migration 046 tried to read the cron URL+secret via ALTER DATABASE
-- ... SET app.retry_payouts_* = ..., which Supabase's hosted Postgres
-- rejects (permission denied — only superuser can register custom
-- GUC names). This migration switches to the Supabase-native pattern:
--
--   - URL is hardcoded inside the wrapper function (it's not secret —
--     it's just the public edge-function URL).
--   - Secret is read from `vault.decrypted_secrets` where it lives
--     encrypted at rest and never appears in logs/SQL history.
--
-- Operator must populate the Vault secret AFTER this migration runs:
--
--   SELECT vault.create_secret(
--     '<paste-the-random-secret>',
--     'payout_retry_cron_secret',
--     'Header value sent to retry-failed-payouts edge function'
--   );
--
-- The same string also goes to the edge function via:
--   supabase secrets set PAYOUT_RETRY_CRON_SECRET=<same-random-secret>
-- ============================================================

CREATE OR REPLACE FUNCTION public.cron_retry_failed_payouts()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, pg_temp
AS $$
DECLARE
  -- Hardcoded — public edge function URL, no secret in here.
  v_url CONSTANT TEXT := 'https://alxzlfutyhuyetqimlxi.supabase.co/functions/v1/retry-failed-payouts';
  v_secret TEXT;
  v_request_id BIGINT;
BEGIN
  SELECT decrypted_secret
    INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'payout_retry_cron_secret'
    LIMIT 1;

  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE NOTICE 'cron_retry_failed_payouts: vault secret payout_retry_cron_secret not set, skipping';
    RETURN 0;
  END IF;

  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type',    'application/json',
      'X-Retry-Source',  'cron',
      'X-Cron-Secret',   v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cron_retry_failed_payouts() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cron_retry_failed_payouts() TO postgres, service_role;

-- The cron schedule from 046 still points at this function — no need to
-- re-schedule. cron.schedule is idempotent on name, but re-asserting the
-- schedule defensively in case the previous version got dropped:
DO $$
BEGIN
  PERFORM cron.unschedule('retry-failed-payouts-nightly');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'retry-failed-payouts-nightly',
  '0 4 * * *',
  $$ SELECT public.cron_retry_failed_payouts(); $$
);
