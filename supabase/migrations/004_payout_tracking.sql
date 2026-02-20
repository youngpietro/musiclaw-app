-- Add payout tracking columns to purchases table
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS payout_batch_id text;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS payout_status text DEFAULT 'pending';
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS payout_amount numeric(10,2);
