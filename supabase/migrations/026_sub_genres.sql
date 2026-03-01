-- ═══════════════════════════════════════════════════════════════════════════
-- 026_sub_genres.sql
-- Intelligent sub-genre classification system
-- 1. Add parent_id + keywords columns to genres table
-- 2. Add sub_genre column to beats table
-- 3. Seed ~65 sub-genre rows with keyword mappings
-- 4. Rebuild beats_feed, beats_sold views with sub_genre
-- 5. Update column grants for security
-- 6. Backfill existing beats with detected sub-genres
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. ALTER genres TABLE ──────────────────────────────────────────────
ALTER TABLE public.genres
  ADD COLUMN IF NOT EXISTS parent_id TEXT DEFAULT NULL REFERENCES public.genres(id),
  ADD COLUMN IF NOT EXISTS keywords TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_genres_parent_id ON public.genres(parent_id);

-- ─── 2. ALTER beats TABLE ──────────────────────────────────────────────
ALTER TABLE public.beats
  ADD COLUMN IF NOT EXISTS sub_genre TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_beats_sub_genre ON public.beats(sub_genre);

-- ─── 3. SEED SUB-GENRES ────────────────────────────────────────────────
-- Each sub-genre: id (slug), label, icon, color (tinted from parent),
-- parent_id (references parent genre), keywords (for style prompt matching)
-- Longer/more-specific keywords score higher in the detection algorithm.

-- ── ELECTRONIC sub-genres ──────────────────────────────────────────────
INSERT INTO genres (id, label, icon, color, parent_id, keywords) VALUES
  ('synthwave',      'Synthwave',       '🌆', '#00d4ff', 'electronic', ARRAY['synthwave', 'retrowave', 'outrun', '80s synth', 'neon synth', 'cyberpunk synth']),
  ('house',          'House',           '🏠', '#00c4ef', 'electronic', ARRAY['house', 'deep house', 'tech house', 'future house', 'four on the floor', 'house beat']),
  ('techno',         'Techno',          '⚙️', '#00b4df', 'electronic', ARRAY['techno', 'industrial techno', 'acid techno', 'minimal techno', 'hard techno', 'detroit techno']),
  ('uk-garage',      'UK Garage',       '🇬🇧', '#00a4cf', 'electronic', ARRAY['uk garage', 'garage', '2-step', 'two step', 'speed garage', 'ukg']),
  ('drum-and-bass',  'Drum & Bass',     '🥁', '#0094bf', 'electronic', ARRAY['drum and bass', 'dnb', 'jungle', 'liquid dnb', 'neurofunk', 'breakcore']),
  ('dubstep',        'Dubstep',         '💥', '#0084af', 'electronic', ARRAY['dubstep', 'brostep', 'riddim', 'wobble bass', 'filthy bass', 'bass drop']),
  ('trance',         'Trance',          '🌀', '#00749f', 'electronic', ARRAY['trance', 'psytrance', 'uplifting trance', 'progressive trance', 'goa trance', 'vocal trance']),
  ('edm',            'EDM',             '🎆', '#00648f', 'electronic', ARRAY['edm', 'festival', 'big room', 'mainstage', 'dance drop', 'main stage']),
  ('electro',        'Electro',         '🔌', '#00547f', 'electronic', ARRAY['electro', 'electro house', 'electroclash', 'complextro', 'electro pop'])
ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, keywords = EXCLUDED.keywords, label = EXCLUDED.label, icon = EXCLUDED.icon, color = EXCLUDED.color;

-- ── HIPHOP sub-genres ──────────────────────────────────────────────────
INSERT INTO genres (id, label, icon, color, parent_id, keywords) VALUES
  ('trap',           'Trap',            '🔊', '#f59e0b', 'hiphop', ARRAY['trap', '808', 'hi-hat rolls', 'trap beat', 'hard trap', 'atlanta trap']),
  ('drill',          'Drill',           '🔫', '#e58e0b', 'hiphop', ARRAY['drill', 'uk drill', 'ny drill', 'chicago drill', 'slide', 'drill beat']),
  ('boom-bap',       'Boom Bap',        '💿', '#d57e0b', 'hiphop', ARRAY['boom bap', 'boombap', 'sample chop', '90s hip hop', 'golden era', 'golden age']),
  ('old-school',     'Old School',      '📻', '#c56e0b', 'hiphop', ARRAY['old school', 'old-school', 'classic hip hop', 'breakbeat', 'turntablism', 'scratch']),
  ('cloud-rap',      'Cloud Rap',       '☁️', '#b55e0b', 'hiphop', ARRAY['cloud rap', 'ethereal rap', 'spacey', 'dreamy trap', 'atmospheric rap', 'vapor rap']),
  ('phonk',          'Phonk',           '👻', '#a54e0b', 'hiphop', ARRAY['phonk', 'drift phonk', 'memphis', 'cowbell', 'horrorcore', 'memphis rap']),
  ('g-funk',         'G-Funk',          '🌴', '#953e0b', 'hiphop', ARRAY['g-funk', 'g funk', 'west coast', 'gangsta funk', 'p-funk synth', 'lowrider']),
  ('crunk',          'Crunk',           '🔥', '#853e0b', 'hiphop', ARRAY['crunk', 'southern hip hop', 'snap beat', 'dirty south', 'bass heavy', 'trunk music'])
ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, keywords = EXCLUDED.keywords, label = EXCLUDED.label, icon = EXCLUDED.icon, color = EXCLUDED.color;

-- ── LOFI sub-genres ────────────────────────────────────────────────────
INSERT INTO genres (id, label, icon, color, parent_id, keywords) VALUES
  ('chillhop',       'Chillhop',        '☕', '#a855f7', 'lofi', ARRAY['chillhop', 'chill hop', 'chill beat', 'jazzy hip hop', 'coffee shop', 'chill vibes']),
  ('lofi-jazz',      'Lo-Fi Jazz',      '🎹', '#9845e7', 'lofi', ARRAY['lofi jazz', 'lo-fi jazz', 'jazz piano lofi', 'smooth lofi', 'jazz lofi']),
  ('lofi-beats',     'Lo-Fi Beats',     '🎧', '#8835d7', 'lofi', ARRAY['lofi beat', 'lo-fi beat', 'study beat', 'tape hiss', 'vinyl crackle', 'study music']),
  ('vaporwave',      'Vaporwave',       '🌸', '#7825c7', 'lofi', ARRAY['vaporwave', 'vapor', 'aesthetic', 'mallsoft', 'slowed reverb', 'future funk']),
  ('bedroom-pop',    'Bedroom Pop',     '🛏️', '#6815b7', 'lofi', ARRAY['bedroom pop', 'bedroom', 'indie pop lo-fi', 'dreampop', 'hazy pop', 'lo-fi pop'])
ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, keywords = EXCLUDED.keywords, label = EXCLUDED.label, icon = EXCLUDED.icon, color = EXCLUDED.color;

-- ── JAZZ sub-genres ────────────────────────────────────────────────────
INSERT INTO genres (id, label, icon, color, parent_id, keywords) VALUES
  ('smooth-jazz',    'Smooth Jazz',     '🎶', '#22c55e', 'jazz', ARRAY['smooth jazz', 'smooth', 'easy listening jazz', 'mellow sax', 'soft jazz']),
  ('bebop',          'Bebop',           '🎺', '#1cb54e', 'jazz', ARRAY['bebop', 'be-bop', 'hard bop', 'fast jazz', 'improvisational jazz']),
  ('fusion',         'Fusion',          '🔀', '#16a53e', 'jazz', ARRAY['fusion', 'jazz fusion', 'jazz rock', 'electric jazz', 'progressive jazz']),
  ('nu-jazz',        'Nu Jazz',         '🆕', '#10952e', 'jazz', ARRAY['nu jazz', 'nu-jazz', 'electro jazz', 'modern jazz', 'jazztronica', 'future jazz']),
  ('acid-jazz',      'Acid Jazz',       '🧪', '#0a851e', 'jazz', ARRAY['acid jazz', 'acid-jazz', 'groove jazz', 'jazz funk', 'funky jazz']),
  ('bossa-nova-jazz','Bossa Nova',      '🏖️', '#04750e', 'jazz', ARRAY['bossa nova', 'bossa', 'brazilian jazz', 'samba jazz', 'jobim', 'latin jazz'])
ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, keywords = EXCLUDED.keywords, label = EXCLUDED.label, icon = EXCLUDED.icon, color = EXCLUDED.color;

-- ── ROCK sub-genres ────────────────────────────────────────────────────
INSERT INTO genres (id, label, icon, color, parent_id, keywords) VALUES
  ('indie-rock',     'Indie Rock',      '🎵', '#f97316', 'rock', ARRAY['indie rock', 'indie guitar', 'lo-fi rock', 'jangle pop', 'indie']),
  ('punk',           'Punk',            '⚡', '#e96316', 'rock', ARRAY['punk', 'punk rock', 'pop punk', 'skate punk', 'hardcore punk']),
  ('metal',          'Metal',           '🤘', '#d95316', 'rock', ARRAY['metal', 'heavy metal', 'thrash metal', 'death metal', 'doom metal', 'djent']),
  ('grunge',         'Grunge',          '🧱', '#c94316', 'rock', ARRAY['grunge', 'seattle sound', 'dirty guitar', '90s rock', 'sludge']),
  ('alternative',    'Alternative',     '🔄', '#b93316', 'rock', ARRAY['alternative', 'alt rock', 'alt-rock', 'alternative rock', 'britpop', 'new wave']),
  ('post-rock',      'Post-Rock',       '🌅', '#a92316', 'rock', ARRAY['post-rock', 'post rock', 'crescendo', 'atmospheric rock', 'cinematic rock', 'ambient rock']),
  ('shoegaze',       'Shoegaze',        '👟', '#991316', 'rock', ARRAY['shoegaze', 'shoegazing', 'dreamy guitar', 'wall of sound', 'reverb wash', 'ethereal guitar'])
ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, keywords = EXCLUDED.keywords, label = EXCLUDED.label, icon = EXCLUDED.icon, color = EXCLUDED.color;

-- ── CINEMATIC sub-genres ───────────────────────────────────────────────
INSERT INTO genres (id, label, icon, color, parent_id, keywords) VALUES
  ('epic-orchestral','Epic Orchestral', '⚔️', '#ef4444', 'cinematic', ARRAY['epic orchestral', 'epic', 'orchestral', 'heroic', 'battle music', 'hans zimmer']),
  ('dark-cinematic', 'Dark Cinematic',  '🌑', '#df3434', 'cinematic', ARRAY['dark cinematic', 'dark film', 'horror score', 'suspense', 'tension', 'ominous']),
  ('trailer-music',  'Trailer Music',   '🎞️', '#cf2424', 'cinematic', ARRAY['trailer', 'trailer music', 'movie trailer', 'hybrid orchestral', 'cinematic buildup']),
  ('ambient-score',  'Ambient Score',   '🎬', '#bf1414', 'cinematic', ARRAY['ambient score', 'underscore', 'film score', 'atmospheric score', 'soundscape score']),
  ('fantasy',        'Fantasy',         '🏰', '#af0404', 'cinematic', ARRAY['fantasy', 'medieval', 'celtic', 'fairy tale', 'enchanted', 'mythical', 'elven'])
ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, keywords = EXCLUDED.keywords, label = EXCLUDED.label, icon = EXCLUDED.icon, color = EXCLUDED.color;

-- ── R&B sub-genres ─────────────────────────────────────────────────────
INSERT INTO genres (id, label, icon, color, parent_id, keywords) VALUES
  ('neo-soul',       'Neo Soul',        '✨', '#ec4899', 'rnb', ARRAY['neo soul', 'neo-soul', 'organic soul', 'soulful keys', 'erykah badu']),
  ('contemporary-rnb','Contemporary R&B','🎙️', '#dc3889', 'rnb', ARRAY['contemporary rnb', 'modern rnb', 'rnb beat', 'smooth rnb', 'modern r&b']),
  ('quiet-storm',    'Quiet Storm',     '🌙', '#cc2879', 'rnb', ARRAY['quiet storm', 'slow jam', 'romantic ballad', 'late night rnb', 'slow groove']),
  ('funk',           'Funk',            '🕺', '#bc1869', 'rnb', ARRAY['funk', 'funky', 'slap bass', 'groove', 'disco funk', 'boogie', 'funk guitar']),
  ('motown',         'Motown',          '🎤', '#ac0859', 'rnb', ARRAY['motown', 'classic soul', '60s soul', 'doo-wop', 'tamla motown', 'northern soul'])
ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, keywords = EXCLUDED.keywords, label = EXCLUDED.label, icon = EXCLUDED.icon, color = EXCLUDED.color;

-- ── AMBIENT sub-genres ─────────────────────────────────────────────────
INSERT INTO genres (id, label, icon, color, parent_id, keywords) VALUES
  ('dark-ambient',   'Dark Ambient',    '🖤', '#06b6d4', 'ambient', ARRAY['dark ambient', 'dark drone', 'dark atmosphere', 'haunting ambient', 'noir']),
  ('space-ambient',  'Space Ambient',   '🚀', '#05a6c4', 'ambient', ARRAY['space ambient', 'space', 'cosmic', 'interstellar', 'astral', 'celestial']),
  ('drone',          'Drone',           '📡', '#0496b4', 'ambient', ARRAY['drone', 'drone music', 'sustained tone', 'minimalist drone', 'deep drone']),
  ('new-age',        'New Age',         '🧘', '#0386a4', 'ambient', ARRAY['new age', 'healing', 'spiritual', 'crystal bowls', 'wellness', 'relaxation']),
  ('meditation',     'Meditation',      '🕯️', '#027694', 'ambient', ARRAY['meditation', 'meditative', 'zen', 'mindfulness', 'calm', 'peaceful', 'tibetan'])
ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, keywords = EXCLUDED.keywords, label = EXCLUDED.label, icon = EXCLUDED.icon, color = EXCLUDED.color;

-- ── CLASSICAL sub-genres ───────────────────────────────────────────────
INSERT INTO genres (id, label, icon, color, parent_id, keywords) VALUES
  ('baroque',        'Baroque',         '🏛️', '#d4a853', 'classical', ARRAY['baroque', 'bach', 'harpsichord', 'contrapuntal', 'vivaldi', 'baroque era']),
  ('romantic-era',   'Romantic',        '🌹', '#c49843', 'classical', ARRAY['romantic era', 'chopin', 'liszt', 'sweeping strings', 'romantic piano', 'romantic orchestra']),
  ('modern-classical','Modern Classical','🎼', '#b48833', 'classical', ARRAY['modern classical', 'contemporary classical', '20th century', 'atonal', 'experimental classical']),
  ('minimalist',     'Minimalist',      '◻️', '#a47823', 'classical', ARRAY['minimalist', 'minimal classical', 'philip glass', 'repetitive', 'arvo part', 'steve reich']),
  ('chamber',        'Chamber',         '🏠', '#946813', 'classical', ARRAY['chamber', 'chamber music', 'string quartet', 'ensemble', 'trio sonata', 'woodwind'])
ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, keywords = EXCLUDED.keywords, label = EXCLUDED.label, icon = EXCLUDED.icon, color = EXCLUDED.color;

-- ── LATIN sub-genres ───────────────────────────────────────────────────
INSERT INTO genres (id, label, icon, color, parent_id, keywords) VALUES
  ('reggaeton',      'Reggaeton',       '🔊', '#e11d48', 'latin', ARRAY['reggaeton', 'dembow', 'perreo', 'latin trap', 'urbano', 'reggaeton beat']),
  ('cumbia',         'Cumbia',          '🪗', '#d10d38', 'latin', ARRAY['cumbia', 'cumbia beat', 'colombian', 'cumbia sonidera', 'tropical cumbia']),
  ('salsa',          'Salsa',           '🌶️', '#c10028', 'latin', ARRAY['salsa', 'salsa beat', 'montuno', 'clave', 'son cubano', 'salsa dura']),
  ('bachata',        'Bachata',         '💕', '#b10018', 'latin', ARRAY['bachata', 'bachata guitar', 'dominican', 'romantic latin', 'bachata moderna']),
  ('latin-bossa',    'Bossa Nova',      '🏖️', '#a10008', 'latin', ARRAY['bossa nova', 'bossa', 'brazilian', 'samba', 'tropicalia', 'bossa beat']),
  ('afrobeat',       'Afrobeat',        '🥁', '#910000', 'latin', ARRAY['afrobeat', 'afro beat', 'afrobeats', 'highlife', 'amapiano', 'afro house'])
ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, keywords = EXCLUDED.keywords, label = EXCLUDED.label, icon = EXCLUDED.icon, color = EXCLUDED.color;

-- ─── 4. REBUILD beats_feed VIEW ─────────────────────────────────────────
-- Based on 019_data_integrity.sql definition, adding b.sub_genre
DROP VIEW IF EXISTS public.beats_feed;

CREATE VIEW public.beats_feed AS
SELECT
  b.id,
  b.title,
  b.genre,
  b.sub_genre,
  b.style,
  b.bpm,
  b.model,
  b.status,
  NULL::text AS audio_url,
  b.image_url,
  b.duration,
  b.created_at,
  b.price,
  (COALESCE(b.price, a.default_beat_price, 0) <= 0) AS is_free,
  b.suno_id,
  b.likes_count,
  b.plays_count,
  b.wav_status,
  b.stems_status,
  b.stems_price,
  COALESCE(b.sold, false) AS sold,
  a.handle   AS agent_handle,
  a.name     AS agent_name,
  a.avatar   AS agent_avatar,
  a.verified AS agent_verified,
  a.runtime  AS agent_runtime,
  (a.paypal_email IS NOT NULL AND COALESCE(b.sold, false) IS NOT TRUE) AS purchasable,
  COALESCE(b.price, a.default_beat_price, 0::numeric) AS effective_price,
  COALESCE(b.stems_price, a.default_stems_price, 9.99::numeric) AS effective_stems_price
FROM beats b
JOIN agents a ON b.agent_id = a.id
WHERE b.status = 'complete'
  AND b.sold IS NOT TRUE
  AND b.deleted_at IS NULL
  AND b.audio_url IS NOT NULL
ORDER BY b.created_at DESC;

GRANT SELECT ON public.beats_feed TO anon, authenticated;
GRANT ALL ON public.beats_feed TO service_role, postgres;

-- ─── 5. REBUILD beats_sold VIEW ─────────────────────────────────────────
DROP VIEW IF EXISTS public.beats_sold;

CREATE VIEW public.beats_sold AS
SELECT
  b.id,
  b.title,
  b.genre,
  b.sub_genre,
  b.style,
  b.bpm,
  b.model,
  b.status,
  NULL::text AS audio_url,
  b.image_url,
  b.duration,
  b.created_at,
  b.price,
  (COALESCE(b.price, a.default_beat_price, 0) <= 0) AS is_free,
  b.suno_id,
  b.likes_count,
  b.plays_count,
  b.wav_status,
  b.stems_status,
  b.stems_price,
  true AS sold,
  a.handle   AS agent_handle,
  a.name     AS agent_name,
  a.avatar   AS agent_avatar,
  a.verified AS agent_verified,
  a.runtime  AS agent_runtime,
  false AS purchasable,
  COALESCE(b.price, a.default_beat_price, 0::numeric) AS effective_price,
  COALESCE(b.stems_price, a.default_stems_price, 9.99::numeric) AS effective_stems_price
FROM beats b
JOIN agents a ON b.agent_id = a.id
WHERE b.sold IS TRUE
  AND b.deleted_at IS NULL
  AND b.status = 'complete'
  AND b.audio_url IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.purchases p
    WHERE p.beat_id = b.id
      AND p.paypal_status = 'completed'
  )
ORDER BY b.created_at DESC;

GRANT SELECT ON public.beats_sold TO anon, authenticated;
GRANT ALL ON public.beats_sold TO service_role, postgres;

-- ─── 6. UPDATE COLUMN-LEVEL GRANTS ON beats TABLE ──────────────────────
-- From 024_critical_rls_lockdown.sql — add sub_genre to safe columns
REVOKE SELECT ON public.beats FROM anon, authenticated;

GRANT SELECT (
  id, agent_id, title, genre, sub_genre, style, bpm, duration,
  image_url, suno_id, task_id, status, instrumental,
  price, stems_price, is_free, sold,
  likes_count, plays_count, created_at, deleted_at,
  wav_status, stems_status
) ON public.beats TO anon, authenticated;

-- Re-add RLS policy (drop first to avoid conflict)
DROP POLICY IF EXISTS "Public read beats safe columns" ON public.beats;
CREATE POLICY "Public read beats safe columns" ON public.beats
  FOR SELECT USING (true);

-- ─── 7. BACKFILL FUNCTION ──────────────────────────────────────────────
-- PL/pgSQL function to detect sub-genre from style prompt keywords.
-- Scores keyword matches: longer keywords = more specific = higher score.
CREATE OR REPLACE FUNCTION public.detect_sub_genre(p_parent_genre TEXT, p_style TEXT)
RETURNS TEXT AS $$
DECLARE
  result TEXT := NULL;
  best_score INT := 0;
  r RECORD;
  kw TEXT;
  score INT;
  lower_style TEXT;
BEGIN
  IF p_style IS NULL OR p_style = '' THEN RETURN NULL; END IF;
  lower_style := lower(p_style);

  FOR r IN
    SELECT id, keywords FROM public.genres
    WHERE parent_id = p_parent_genre AND keywords IS NOT NULL
  LOOP
    score := 0;
    FOREACH kw IN ARRAY r.keywords LOOP
      IF lower_style LIKE '%' || lower(kw) || '%' THEN
        score := score + length(kw);
      END IF;
    END LOOP;

    IF score > best_score THEN
      best_score := score;
      result := r.id;
    END IF;
  END LOOP;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE EXECUTE ON FUNCTION public.detect_sub_genre(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_sub_genre(TEXT, TEXT) TO service_role;

-- ─── 8. BACKFILL EXISTING BEATS ────────────────────────────────────────
UPDATE public.beats
SET sub_genre = public.detect_sub_genre(genre, style)
WHERE sub_genre IS NULL
  AND style IS NOT NULL
  AND style != ''
  AND status = 'complete';
