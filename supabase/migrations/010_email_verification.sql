-- 010_email_verification.sql
-- Email verification codes for buyer email validation before purchase.
-- Buyers must verify their email via a 6-digit code before PayPal checkout.

CREATE TABLE IF NOT EXISTS public.email_verifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  code        text NOT NULL,
  expires_at  timestamptz NOT NULL,
  verified    boolean DEFAULT false,
  created_at  timestamptz DEFAULT now()
);

-- Fast lookup: find valid code for email verification
CREATE INDEX idx_email_verifications_lookup
  ON public.email_verifications(email, code, expires_at DESC);

-- Rate limit counting: recent sends per email
CREATE INDEX idx_email_verifications_email_recent
  ON public.email_verifications(email, created_at DESC);

ALTER TABLE public.email_verifications ENABLE ROW LEVEL SECURITY;

-- Service role only — edge functions handle all access
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'email_verifications'
    AND policyname = 'Service insert email_verifications') THEN
    CREATE POLICY "Service insert email_verifications"
      ON public.email_verifications FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'email_verifications'
    AND policyname = 'Service select email_verifications') THEN
    CREATE POLICY "Service select email_verifications"
      ON public.email_verifications FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'email_verifications'
    AND policyname = 'Service update email_verifications') THEN
    CREATE POLICY "Service update email_verifications"
      ON public.email_verifications FOR UPDATE USING (true);
  END IF;
END $$;
