-- ============================================================
-- 048 · PayPal Webhook Idempotency Table
-- ============================================================
-- The paypal-webhook edge function deduplicates PayPal's
-- at-least-once delivery by inserting (event_id) with a unique
-- primary key. A unique-violation tells the handler "we've
-- already processed this event — return 200 immediately".
--
-- raw_event preserves the full payload for forensics / replay.
-- processed_at + process_error capture handler outcome so we
-- can audit which deliveries actually drove DB changes.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.paypal_webhook_events (
  event_id      TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  resource_id   TEXT,
  raw_event     JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  process_error TEXT
);

CREATE INDEX IF NOT EXISTS paypal_webhook_events_resource_idx
  ON public.paypal_webhook_events (resource_id);

CREATE INDEX IF NOT EXISTS paypal_webhook_events_received_idx
  ON public.paypal_webhook_events (received_at DESC);

-- Service-role only (no public RLS policies needed — the table
-- is written exclusively by the paypal-webhook edge function
-- using the service role key).
ALTER TABLE public.paypal_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.paypal_webhook_events FROM PUBLIC, anon, authenticated;
GRANT  ALL ON public.paypal_webhook_events TO service_role;
