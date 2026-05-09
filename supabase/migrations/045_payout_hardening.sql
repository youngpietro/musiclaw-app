-- ============================================================
-- 045 · Payout Hardening
-- ============================================================
-- Adds the audit + retry plumbing the payout pipeline was missing:
--
--   1. purchases:    payout_attempts / payout_last_attempt_at / payout_error
--   2. sample_payouts: same three columns
--   3. agents:       auto_payout_enabled / auto_payout_threshold
--   4. Partial indexes on failed/error rows so the retry cron
--      can scan in O(failed_count) instead of O(all_rows).
--   5. Rebuild owner_dashboard() RPC to surface auto-payout
--      settings + failed-payout counts.
--
-- Backfill: existing rows get sane defaults (attempts=0, no error,
-- auto_payout_enabled=true so historical agents opt in by default).
-- An owner can toggle off via the dashboard.
-- ============================================================

-- ─── 1. PURCHASES — beat sale payout audit ────────────────────
ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS payout_attempts          INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payout_last_attempt_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payout_error             TEXT;

COMMENT ON COLUMN public.purchases.payout_attempts IS
  'Number of times capture-order or retry-failed-payouts has tried to send the 80% to the agent.';
COMMENT ON COLUMN public.purchases.payout_last_attempt_at IS
  'Timestamp of the most recent payout attempt (success or failure).';
COMMENT ON COLUMN public.purchases.payout_error IS
  'Last PayPal error message. Cleared when payout_status flips to "sent".';

-- Partial index — retry cron only looks at failed rows.
CREATE INDEX IF NOT EXISTS idx_purchases_payout_retry_queue
  ON public.purchases (payout_last_attempt_at)
  WHERE payout_status IN ('failed', 'error');

-- ─── 2. SAMPLE_PAYOUTS — same columns, same purpose ───────────
ALTER TABLE public.sample_payouts
  ADD COLUMN IF NOT EXISTS payout_attempts          INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payout_last_attempt_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payout_error             TEXT;

COMMENT ON COLUMN public.sample_payouts.payout_attempts IS
  'Number of times payout-sample-earnings or retry-failed-payouts has tried to send this batch.';
COMMENT ON COLUMN public.sample_payouts.payout_last_attempt_at IS
  'Timestamp of the most recent payout attempt (success or failure).';
COMMENT ON COLUMN public.sample_payouts.payout_error IS
  'Last PayPal error message. Cleared when status flips to "sent".';

CREATE INDEX IF NOT EXISTS idx_sample_payouts_retry_queue
  ON public.sample_payouts (payout_last_attempt_at)
  WHERE status IN ('failed', 'error');

-- ─── 3. AGENTS — auto-payout opt-in + threshold ───────────────
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS auto_payout_enabled    BOOLEAN        NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS auto_payout_threshold  NUMERIC(10,2)  NOT NULL DEFAULT 5.00;

-- Constraint added separately so the migration is safe to re-run on a DB
-- where the columns already exist without the check.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agents_auto_payout_threshold_range'
  ) THEN
    ALTER TABLE public.agents
      ADD CONSTRAINT agents_auto_payout_threshold_range
      CHECK (auto_payout_threshold >= 5.00 AND auto_payout_threshold <= 10000.00);
  END IF;
END $$;

COMMENT ON COLUMN public.agents.auto_payout_enabled IS
  'When TRUE, sample earnings auto-disburse on purchase once pending_sample_earnings crosses auto_payout_threshold.';
COMMENT ON COLUMN public.agents.auto_payout_threshold IS
  'Minimum pending_sample_earnings (USD) before the auto-payout fires. Floor enforced at $5.00 to match manual-payout floor.';

-- ─── 4. UPDATE owner_dashboard RPC ────────────────────────────
-- Rebuild matching 042's structure (returns json, uses row_to_json,
-- reads a.beats_count denormalized, total_earnings from amount-platform_fee,
-- total_plays from b.plays_count). Append:
--   auto_payout_enabled, auto_payout_threshold,
--   failed_beat_payouts, failed_sample_payouts, last_failed_payout
-- ─────────────────────────────────────────────────────────────

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
      a.paypal_email,

      -- Auto-payout settings
      COALESCE(a.auto_payout_enabled, true)        AS auto_payout_enabled,
      COALESCE(a.auto_payout_threshold, 5.00)      AS auto_payout_threshold,

      -- Beat stats
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
      ) AS total_earnings,

      -- Total plays across all beats
      (
        SELECT COALESCE(SUM(b.plays_count), 0) FROM public.beats b
        WHERE b.agent_id = a.id AND b.status = 'complete' AND b.deleted_at IS NULL
      ) AS total_plays,

      -- Sample earnings
      COALESCE(a.pending_sample_earnings, 0) AS pending_sample_earnings,

      (
        SELECT count(*)
        FROM public.sample_purchases sp
        JOIN public.samples s ON sp.sample_id = s.id
        JOIN public.beats  b  ON s.beat_id   = b.id
        WHERE b.agent_id = a.id
      ) AS samples_sold,

      (
        SELECT COALESCE(SUM(sp.agent_earning), 0)
        FROM public.sample_purchases sp
        JOIN public.samples s ON sp.sample_id = s.id
        JOIN public.beats  b  ON s.beat_id   = b.id
        WHERE b.agent_id = a.id
      ) AS total_sample_revenue,

      -- Recent sample sales (last 10)
      (
        SELECT COALESCE(json_agg(row_to_json(ss)), '[]'::json)
        FROM (
          SELECT sp.created_at, sp.agent_earning, sp.credits_spent,
                 s.stem_type, b.title as beat_title
          FROM public.sample_purchases sp
          JOIN public.samples s ON sp.sample_id = s.id
          JOIN public.beats b ON s.beat_id = b.id
          WHERE b.agent_id = a.id
          ORDER BY sp.created_at DESC
          LIMIT 10
        ) ss
      ) AS recent_sample_sales,

      -- Failed-payout health surface
      (
        SELECT count(*)
        FROM public.purchases p
        JOIN public.beats b ON p.beat_id = b.id
        WHERE b.agent_id = a.id AND p.payout_status IN ('failed', 'error')
      ) AS failed_beat_payouts,

      (
        SELECT count(*)
        FROM public.sample_payouts sp
        WHERE sp.agent_id = a.id AND sp.status IN ('failed', 'error')
      ) AS failed_sample_payouts,

      (
        SELECT max(t2.last_attempt_at) FROM (
          SELECT p.payout_last_attempt_at AS last_attempt_at
            FROM public.purchases p
            JOIN public.beats b2 ON p.beat_id = b2.id
            WHERE b2.agent_id = a.id AND p.payout_status IN ('failed', 'error')
          UNION ALL
          SELECT sp.payout_last_attempt_at
            FROM public.sample_payouts sp
            WHERE sp.agent_id = a.id AND sp.status IN ('failed', 'error')
        ) t2
      ) AS last_failed_payout,

      -- Self-hosted config
      a.suno_self_hosted_url,

      -- Pro plan verification
      COALESCE(a.suno_plan_verified, false) AS suno_plan_verified,
      a.suno_plan_type,
      a.suno_plan_verified_at,

      -- Cookie life tracking
      a.suno_credits_left,
      a.suno_monthly_limit,
      a.suno_credits_checked_at

    FROM public.agents a
    WHERE a.owner_email = lower(trim(p_email))
    ORDER BY a.created_at DESC
  ) t;

  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.owner_dashboard(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.owner_dashboard(text) TO service_role;
