-- ═══════════════════════════════════════════════════════════════════════════
-- 020_sample_library.sql
-- Sample Library: credit-based stem marketplace
-- 1. user_profiles table (auto-created on Supabase Auth signup)
-- 2. samples table (individual stems available for purchase)
-- 3. sample_purchases table (purchase history)
-- 4. credit_purchases table (PayPal credit package purchases)
-- 5. samples_feed view (available samples with beat/agent info)
-- 6. Add pending_sample_earnings to agents
-- 7. Backfill: create sample rows from existing beats with stems
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. USER PROFILES ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  credit_balance INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile
CREATE POLICY "Users can view own profile"
  ON public.user_profiles FOR SELECT
  USING (auth.uid() = id);

-- Service role can do everything (edge functions)
GRANT ALL ON public.user_profiles TO service_role;
GRANT SELECT ON public.user_profiles TO authenticated;

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_profiles (id)
  VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ─── 2. SAMPLES TABLE ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.samples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beat_id UUID NOT NULL REFERENCES public.beats(id) ON DELETE CASCADE,
  stem_type TEXT NOT NULL,
  audio_url TEXT NOT NULL,
  file_size INTEGER,
  credit_price INTEGER NOT NULL DEFAULT 1,
  purchased_by UUID REFERENCES auth.users(id),
  purchased_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(beat_id, stem_type)
);

CREATE INDEX IF NOT EXISTS idx_samples_beat_id ON public.samples(beat_id);
CREATE INDEX IF NOT EXISTS idx_samples_purchased_by ON public.samples(purchased_by);
CREATE INDEX IF NOT EXISTS idx_samples_stem_type ON public.samples(stem_type);
CREATE INDEX IF NOT EXISTS idx_samples_created_at ON public.samples(created_at DESC);

ALTER TABLE public.samples ENABLE ROW LEVEL SECURITY;

-- Public read for available samples
CREATE POLICY "Anyone can view available samples"
  ON public.samples FOR SELECT
  USING (true);

GRANT ALL ON public.samples TO service_role;
GRANT SELECT ON public.samples TO anon;
GRANT SELECT ON public.samples TO authenticated;

-- ─── 3. SAMPLE PURCHASES ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sample_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id UUID NOT NULL REFERENCES public.samples(id),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  credits_spent INTEGER NOT NULL,
  agent_earning NUMERIC(10,2),
  download_count INTEGER NOT NULL DEFAULT 0,
  download_token TEXT,
  download_expires TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sample_purchases_user_id ON public.sample_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_sample_purchases_sample_id ON public.sample_purchases(sample_id);

ALTER TABLE public.sample_purchases ENABLE ROW LEVEL SECURITY;

-- Users can view their own purchases
CREATE POLICY "Users can view own sample purchases"
  ON public.sample_purchases FOR SELECT
  USING (auth.uid() = user_id);

GRANT ALL ON public.sample_purchases TO service_role;
GRANT SELECT ON public.sample_purchases TO authenticated;

-- ─── 4. CREDIT PURCHASES ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.credit_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  credits_amount INTEGER NOT NULL,
  amount_usd NUMERIC(10,2) NOT NULL,
  paypal_order_id TEXT,
  paypal_capture_id TEXT,
  paypal_status TEXT DEFAULT 'pending' CHECK (paypal_status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_purchases_user_id ON public.credit_purchases(user_id);

ALTER TABLE public.credit_purchases ENABLE ROW LEVEL SECURITY;

-- Users can view their own credit purchases
CREATE POLICY "Users can view own credit purchases"
  ON public.credit_purchases FOR SELECT
  USING (auth.uid() = user_id);

GRANT ALL ON public.credit_purchases TO service_role;
GRANT SELECT ON public.credit_purchases TO authenticated;

-- ─── 5. SAMPLES FEED VIEW ─────────────────────────────────────────────
CREATE OR REPLACE VIEW public.samples_feed AS
SELECT
  s.id,
  s.beat_id,
  s.stem_type,
  s.audio_url,
  s.credit_price,
  s.file_size,
  s.created_at,
  b.title   AS beat_title,
  b.genre   AS beat_genre,
  b.bpm     AS beat_bpm,
  b.image_url AS beat_image_url,
  a.handle  AS agent_handle,
  a.name    AS agent_name,
  a.avatar  AS agent_avatar,
  a.verified AS agent_verified
FROM public.samples s
JOIN public.beats b ON s.beat_id = b.id
JOIN public.agents a ON b.agent_id = a.id
WHERE s.purchased_by IS NULL
  AND (s.file_size IS NULL OR s.file_size > 10000)
ORDER BY s.created_at DESC;

GRANT ALL ON public.samples_feed TO postgres;
GRANT ALL ON public.samples_feed TO anon;
GRANT ALL ON public.samples_feed TO authenticated;
GRANT ALL ON public.samples_feed TO service_role;

-- ─── 6. ADD PENDING SAMPLE EARNINGS TO AGENTS ─────────────────────────
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS pending_sample_earnings NUMERIC(10,2) DEFAULT 0;

-- ─── 7. BACKFILL: CREATE SAMPLES FROM EXISTING STEMS ──────────────────
-- Extract each stem from the JSONB column and insert as a sample row.
-- file_size is NULL (unvalidated) — these will still show in the feed.
INSERT INTO public.samples (beat_id, stem_type, audio_url)
SELECT b.id, stem.key, stem.value
FROM public.beats b,
     LATERAL jsonb_each_text(b.stems) AS stem(key, value)
WHERE b.stems IS NOT NULL
  AND b.stems_status = 'complete'
  AND b.deleted_at IS NULL
  AND b.sold IS NOT TRUE
  AND stem.value IS NOT NULL
  AND stem.value != ''
  AND stem.key != 'origin'
ON CONFLICT (beat_id, stem_type) DO NOTHING;

-- ─── 8. RPC: INCREMENT AGENT SAMPLE EARNINGS ──────────────────────────
CREATE OR REPLACE FUNCTION public.increment_agent_sample_earnings(
  p_agent_id UUID,
  p_amount NUMERIC
)
RETURNS void AS $$
BEGIN
  UPDATE public.agents
  SET pending_sample_earnings = COALESCE(pending_sample_earnings, 0) + p_amount
  WHERE id = p_agent_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
