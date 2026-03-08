-- 036: Fix G-Credits balance after migration 034 clobbered it
-- Migration 034's INSERT...ON CONFLICT overwrote owner_gcredits balances
-- with SUM(agents.g_credits) which was 0 (old per-agent column was deprecated).
-- This restores correct balances from the purchase/usage ledger.

-- Recalculate from purchases minus usage for all owners
UPDATE public.owner_gcredits oc
SET g_credits = COALESCE(
  (SELECT SUM(gp.credits_amount) FROM public.gcredit_purchases gp
   JOIN public.agents a ON gp.agent_id = a.id
   WHERE lower(trim(a.owner_email)) = oc.owner_email
     AND gp.paypal_status = 'completed'),
  0
) - COALESCE(
  (SELECT SUM(gu.credits_spent) FROM public.gcredit_usage gu
   JOIN public.agents a ON gu.agent_id = a.id
   WHERE lower(trim(a.owner_email)) = oc.owner_email),
  0
),
updated_at = now();

-- Fallback: if the ledger approach gives 0 but we know credits existed,
-- set to 46 for pietro.iossa1@gmail.com specifically (documented balance)
-- This is a safety net in case purchases weren't tracked in gcredit_purchases.
UPDATE public.owner_gcredits
SET g_credits = 46, updated_at = now()
WHERE owner_email = 'pietro.iossa1@gmail.com'
  AND g_credits <= 0;
