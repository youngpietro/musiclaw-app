-- 039_invoices.sql
-- Custom invoice records for all payment types on MusiClaw

-- Sequential invoice number generator
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

-- Invoices table
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,                        -- beat_purchase | credit_purchase | gcredit_purchase | sample_payout
  status TEXT NOT NULL DEFAULT 'paid',       -- paid | refunded

  -- Parties
  buyer_email TEXT,
  seller_email TEXT,

  -- Amounts
  amount NUMERIC(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  platform_fee NUMERIC(10,2),
  seller_amount NUMERIC(10,2),

  -- Line items (JSON array: [{description, quantity, unit_price}])
  line_items JSONB NOT NULL DEFAULT '[]',

  -- References
  paypal_order_id TEXT,
  paypal_capture_id TEXT,
  paypal_payout_batch_id TEXT,
  purchase_id UUID,
  credit_purchase_id UUID,
  gcredit_purchase_id UUID,
  sample_payout_id UUID,

  -- Metadata
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_invoices_type ON invoices(type);
CREATE INDEX IF NOT EXISTS idx_invoices_buyer_email ON invoices(buyer_email);
CREATE INDEX IF NOT EXISTS idx_invoices_seller_email ON invoices(seller_email);
CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices(created_at DESC);

-- RLS: only service role can access invoices
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

-- RPC: Atomically create an invoice with sequential number
CREATE OR REPLACE FUNCTION create_invoice(p_data JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_num INT;
  v_invoice_number TEXT;
  v_id UUID;
BEGIN
  v_num := nextval('invoice_number_seq');
  v_invoice_number := 'MC-INV-' || LPAD(v_num::TEXT, 6, '0');

  INSERT INTO invoices (
    invoice_number, type, status, buyer_email, seller_email,
    amount, currency, platform_fee, seller_amount, line_items,
    paypal_order_id, paypal_capture_id, paypal_payout_batch_id,
    purchase_id, credit_purchase_id, gcredit_purchase_id, sample_payout_id, notes
  ) VALUES (
    v_invoice_number,
    p_data->>'type',
    COALESCE(p_data->>'status', 'paid'),
    p_data->>'buyer_email',
    p_data->>'seller_email',
    (p_data->>'amount')::NUMERIC,
    COALESCE(p_data->>'currency', 'USD'),
    (p_data->>'platform_fee')::NUMERIC,
    (p_data->>'seller_amount')::NUMERIC,
    COALESCE(p_data->'line_items', '[]'::JSONB),
    p_data->>'paypal_order_id',
    p_data->>'paypal_capture_id',
    p_data->>'paypal_payout_batch_id',
    NULLIF(p_data->>'purchase_id', '')::UUID,
    NULLIF(p_data->>'credit_purchase_id', '')::UUID,
    NULLIF(p_data->>'gcredit_purchase_id', '')::UUID,
    NULLIF(p_data->>'sample_payout_id', '')::UUID,
    p_data->>'notes'
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'invoice_number', v_invoice_number);
END;
$$;
