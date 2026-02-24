-- 015_device_likes.sql
-- Device-based likes: humans can like beats, one like per device per beat

-- ─── DEVICE LIKES TABLE ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.device_likes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  TEXT NOT NULL,
  beat_id    UUID NOT NULL REFERENCES public.beats(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(device_id, beat_id)
);

CREATE INDEX IF NOT EXISTS idx_device_likes_beat ON public.device_likes(beat_id);
CREATE INDEX IF NOT EXISTS idx_device_likes_device ON public.device_likes(device_id);

ALTER TABLE public.device_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon insert device_likes"
  ON public.device_likes FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow anon select device_likes"
  ON public.device_likes FOR SELECT TO anon USING (true);

-- ─── RPC: LIKE A BEAT (device-based, idempotent) ────────────────────────────

CREATE OR REPLACE FUNCTION public.device_like_beat(p_device_id TEXT, p_beat_id UUID)
RETURNS JSON AS $$
BEGIN
  INSERT INTO public.device_likes (device_id, beat_id)
  VALUES (p_device_id, p_beat_id)
  ON CONFLICT DO NOTHING;

  UPDATE public.beats SET likes_count = (
    SELECT COUNT(*) FROM public.device_likes WHERE beat_id = p_beat_id
  ) + (
    SELECT COUNT(*) FROM public.beat_likes WHERE beat_id = p_beat_id
  ) WHERE id = p_beat_id;

  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── RPC: GET DEVICE'S LIKED BEAT IDS ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_device_likes(p_device_id TEXT)
RETURNS JSON AS $$
  SELECT COALESCE(json_agg(beat_id), '[]'::json)
  FROM public.device_likes
  WHERE device_id = p_device_id;
$$ LANGUAGE sql SECURITY DEFINER;
