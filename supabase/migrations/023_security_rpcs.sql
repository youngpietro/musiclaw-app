-- 023_security_rpcs.sql
-- Atomic RPC functions for credit deduction and download count increment.
-- Prevents race conditions from concurrent purchases/downloads.

-- ─── 1. ATOMIC CREDIT DEDUCTION ─────────────────────────────────────────
-- Deducts credits at the SQL level: credit_balance = credit_balance - amount
-- Only succeeds if user has enough credits (WHERE credit_balance >= amount).
-- Returns new balance, or -1 if insufficient credits.
CREATE OR REPLACE FUNCTION public.deduct_credits(p_user_id UUID, p_amount INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_balance INT;
BEGIN
  UPDATE public.user_profiles
  SET credit_balance = credit_balance - p_amount,
      updated_at = NOW()
  WHERE id = p_user_id
    AND credit_balance >= p_amount
  RETURNING credit_balance INTO new_balance;

  IF NOT FOUND THEN
    RETURN -1; -- Insufficient credits
  END IF;

  RETURN new_balance;
END;
$$;

-- ─── 2. ATOMIC DOWNLOAD COUNT INCREMENT ─────────────────────────────────
-- Increments download_count on either sample_purchases or purchases table.
-- Uses SQL-level increment to prevent race conditions from concurrent downloads.
-- p_table: 'sample_purchases' or 'purchases'
-- p_id: the row UUID
-- p_delta: increment amount (default 1, use -1 to undo)
CREATE OR REPLACE FUNCTION public.increment_download_count(p_table TEXT, p_id UUID, p_delta INT DEFAULT 1)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_table = 'sample_purchases' THEN
    UPDATE public.sample_purchases
    SET download_count = GREATEST(0, download_count + p_delta)
    WHERE id = p_id;
  ELSIF p_table = 'purchases' THEN
    UPDATE public.purchases
    SET download_count = GREATEST(0, download_count + p_delta)
    WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'Invalid table: %', p_table;
  END IF;
END;
$$;

-- ─── 3. ATOMIC AGENT SAMPLE EARNINGS INCREMENT ─────────────────────────
-- Increments pending_sample_earnings at the SQL level.
CREATE OR REPLACE FUNCTION public.increment_agent_sample_earnings(p_agent_id UUID, p_amount NUMERIC)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.agents
  SET pending_sample_earnings = COALESCE(pending_sample_earnings, 0) + p_amount
  WHERE id = p_agent_id;
END;
$$;

-- Grant execute to service_role (edge functions use service role key)
GRANT EXECUTE ON FUNCTION public.deduct_credits(UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_download_count(TEXT, UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_agent_sample_earnings(UUID, NUMERIC) TO service_role;
