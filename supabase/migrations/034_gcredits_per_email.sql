-- ============================================================
-- 034 · G-Credits Per Email (Owner-Level)
-- ============================================================
-- Changes:
--   1. Creates owner_gcredits table (email → credits pool)
--   2. Migrates existing per-agent credits to owner level
--   3. Atomic RPCs: deduct_owner_gcredits, add_owner_gcredits
-- Context:
--   All agents under the same owner_email share one G-Credits pool.
--   This replaces per-agent g_credits for balance tracking.
--   Per-agent gcredit_usage is kept for attribution.
-- ============================================================

-- ─── 1. OWNER GCREDITS TABLE ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.owner_gcredits (
  owner_email TEXT PRIMARY KEY,
  g_credits   INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.owner_gcredits ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.owner_gcredits TO service_role;

-- ─── 2. MIGRATE EXISTING PER-AGENT CREDITS ───────────────────
-- NOTE: Uses DO NOTHING to avoid clobbering existing balances on re-run.
-- The initial migration populates from agents.g_credits; after that,
-- balances are managed by deduct/add RPCs and should not be overwritten.
INSERT INTO public.owner_gcredits (owner_email, g_credits)
SELECT lower(trim(a.owner_email)), SUM(COALESCE(a.g_credits, 0))::integer
FROM public.agents a
WHERE a.owner_email IS NOT NULL AND trim(a.owner_email) <> ''
GROUP BY lower(trim(a.owner_email))
ON CONFLICT (owner_email) DO NOTHING;

-- ─── 3. DEDUCT OWNER G-CREDITS (fails if insufficient) ───────
CREATE OR REPLACE FUNCTION public.deduct_owner_gcredits(
  p_email TEXT,
  p_amount INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_balance INTEGER;
BEGIN
  UPDATE public.owner_gcredits
  SET g_credits = g_credits - p_amount, updated_at = now()
  WHERE owner_email = lower(trim(p_email))
    AND g_credits >= p_amount
  RETURNING g_credits INTO new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient G-Credits (need %, have less)', p_amount;
  END IF;

  RETURN new_balance;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.deduct_owner_gcredits(TEXT, INTEGER) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.deduct_owner_gcredits(TEXT, INTEGER) TO service_role;

-- ─── 4. ADD OWNER G-CREDITS (upsert for new emails) ──────────
CREATE OR REPLACE FUNCTION public.add_owner_gcredits(
  p_email TEXT,
  p_amount INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_balance INTEGER;
BEGIN
  INSERT INTO public.owner_gcredits (owner_email, g_credits, updated_at)
  VALUES (lower(trim(p_email)), p_amount, now())
  ON CONFLICT (owner_email)
  DO UPDATE SET g_credits = public.owner_gcredits.g_credits + p_amount, updated_at = now()
  RETURNING g_credits INTO new_balance;

  RETURN new_balance;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_owner_gcredits(TEXT, INTEGER) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.add_owner_gcredits(TEXT, INTEGER) TO service_role;
