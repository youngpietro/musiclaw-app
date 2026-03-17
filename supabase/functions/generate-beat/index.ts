// supabase/functions/generate-beat/index.ts
// SECURITY: Rate limiting, CORS restriction, URL validation, safe errors

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://musiclaw.app",
  "https://www.musiclaw.app",
  "https://musiclaw-app.vercel.app",
];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const VALID_MODELS = ["V5"];
// Map user-facing model names → Suno internal identifiers
const SUNO_MODEL_MAP: Record<string, string> = {
  "V5": "chirp-crow",
};
const MAX_BEAT_PRICE = 499.99;
const MAX_STEMS_PRICE = 999.99;

// ─── GENRE NORMALIZATION ──────────────────────────────────────────────
// Canonical aliases: map common variant spellings → proper genre slug
const GENRE_ALIASES: Record<string, string> = {
  // Core aliases
  "hip-hop": "hiphop", "hip hop": "hiphop", "rap": "hiphop",
  "r&b": "rnb", "r-b": "rnb", "randb": "rnb", "r-and-b": "rnb", "rhythm-and-blues": "rnb",
  "lo-fi": "lofi", "lo fi": "lofi",
  "uk-garage": "uk-garage", "ukgarage": "uk-garage", "uk garage": "uk-garage", "2-step": "uk-garage", "2step": "uk-garage",
  "drum-and-bass": "drum-and-bass", "drumandbass": "drum-and-bass", "dnb": "drum-and-bass", "drum and bass": "drum-and-bass", "jungle": "drum-and-bass",
  "triphop": "trip-hop", "trip hop": "trip-hop",
  "synthwave": "synthwave", "synth-wave": "synthwave", "retrowave": "synthwave", "outrun": "synthwave",
  "chillhop": "chillhop", "chill-hop": "chillhop", "chill hop": "chillhop",
  "afrobeat": "afrobeat", "afro-beat": "afrobeat", "afrobeats": "afrobeat",
  // Common alternate names
  "r and b": "rnb", "rhythm and blues": "rnb",
  "neosoul": "neo-soul", "neo soul": "neo-soul",
  "bossanova": "bossa-nova", "bossa nova": "bossa-nova",
  "postrock": "post-rock", "post rock": "post-rock",
  "newwave": "new-wave", "new wave": "new-wave",
  "psytrance": "psytrance", "psy-trance": "psytrance", "psy trance": "psytrance",
  "dance": "edm", "electronic dance music": "edm",
  "d&b": "drum-and-bass", "d and b": "drum-and-bass",
};

function normalizeGenreSlug(raw: string): string {
  const lower = raw.trim().toLowerCase();
  // Check alias map first (before slug conversion)
  if (GENRE_ALIASES[lower]) return GENRE_ALIASES[lower];
  // Convert to slug: spaces/underscores → hyphens, strip special chars
  const slug = lower
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // Check alias map again with the slug form
  if (GENRE_ALIASES[slug]) return GENRE_ALIASES[slug];
  return slug;
}

function genreLabelFromSlug(slug: string): string {
  return slug
    .split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .replace(/\bRnb\b/, "R&B / Soul")
    .replace(/\bHiphop\b/, "Hip-Hop")
    .replace(/\bLofi\b/, "Lo-Fi")
    .replace(/\bUk\b/, "UK")
    .replace(/\bEdm\b/, "EDM")
    .replace(/\bDnb\b/, "D&B");
}

// ─── STYLE-TAG GENRE INFERENCE ─────────────────────────────────────────
// Keyword indicators for each parent genre (weighted by specificity)
// Used to detect when agent declares wrong genre — e.g., says "electronic"
// but style tags say "jazz piano, swing, rhodes"
const GENRE_INDICATORS: Record<string, { keywords: string[]; weight: number }[]> = {
  "jazz": [
    { keywords: ["jazz", "swing", "bebop", "modal jazz", "cool jazz", "free jazz", "hard bop"], weight: 10 },
    { keywords: ["rhodes", "rhodes keyboard", "rhodes chords"], weight: 7 },
    { keywords: ["saxophone", "sax solo", "trumpet solo", "brass section"], weight: 6 },
    { keywords: ["drum brushes", "brush drums", "soft drum brushes", "jazz drums"], weight: 8 },
    { keywords: ["lounge jazz", "smooth jazz", "jazz lounge", "bar jazz", "hotel bar"], weight: 9 },
    { keywords: ["walking bass", "upright bass", "jazz bass"], weight: 7 },
    { keywords: ["jazz piano", "jazz chords", "jazz harmony"], weight: 9 },
    { keywords: ["bossa", "bossa nova"], weight: 6 },
  ],
  "ambient": [
    { keywords: ["ambient", "atmospheric", "ethereal", "drone"], weight: 6 },
    { keywords: ["meditation", "meditative", "zen", "healing"], weight: 7 },
    { keywords: ["pad layers", "pad textures", "soundscape", "texture"], weight: 5 },
    { keywords: ["space ambient", "dark ambient", "deep ambient"], weight: 9 },
    { keywords: ["long reverb", "reverb tails", "infinite reverb"], weight: 4 },
  ],
  "electronic": [
    { keywords: ["electronic", "synth", "synthesizer", "arpeggio"], weight: 4 },
    { keywords: ["edm", "drop", "sidechain", "wobble bass"], weight: 8 },
    { keywords: ["sequencer", "modular", "eurorack"], weight: 7 },
  ],
  "hiphop": [
    { keywords: ["hip hop", "hip-hop", "boom bap", "beatmaking"], weight: 8 },
    { keywords: ["trap", "808", "hi-hat rolls", "trap beat"], weight: 7 },
    { keywords: ["rap", "rap beat", "rap instrumental"], weight: 8 },
    { keywords: ["drill", "uk drill", "ny drill"], weight: 7 },
  ],
  "lofi": [
    { keywords: ["lo-fi", "lofi", "lo fi"], weight: 8 },
    { keywords: ["vinyl crackle", "tape hiss", "tape saturation", "dusty"], weight: 6 },
    { keywords: ["nostalgic", "warm analog", "bedroom producer"], weight: 4 },
    { keywords: ["lofi hip hop", "lofi beats", "study beats", "chill beats"], weight: 9 },
  ],
  "rock": [
    { keywords: ["rock", "guitar riff", "power chord", "distortion guitar"], weight: 7 },
    { keywords: ["grunge", "punk rock", "alternative rock", "indie rock"], weight: 8 },
    { keywords: ["heavy guitar", "electric guitar", "rock drums", "rock anthem"], weight: 6 },
  ],
  "classical": [
    { keywords: ["classical", "orchestral", "symphony", "chamber music"], weight: 8 },
    { keywords: ["violin", "cello", "viola", "string quartet"], weight: 5 },
    { keywords: ["piano sonata", "concerto", "fugue", "baroque"], weight: 9 },
  ],
  "cinematic": [
    { keywords: ["cinematic", "film score", "movie", "trailer"], weight: 8 },
    { keywords: ["epic", "epic orchestral", "heroic", "dramatic"], weight: 6 },
    { keywords: ["soundtrack", "score", "film music"], weight: 7 },
  ],
  "rnb": [
    { keywords: ["r&b", "rnb", "rhythm and blues"], weight: 8 },
    { keywords: ["soul", "soulful", "neo-soul", "neo soul"], weight: 6 },
    { keywords: ["smooth groove", "r&b groove", "slow jam"], weight: 7 },
  ],
  "latin": [
    { keywords: ["latin", "salsa", "cumbia", "reggaeton"], weight: 8 },
    { keywords: ["bossa nova", "samba", "tango", "merengue"], weight: 7 },
    { keywords: ["latin percussion", "congas", "timbales"], weight: 5 },
  ],
  "house": [
    { keywords: ["house music", "four-on-the-floor", "4x4 beat"], weight: 8 },
    { keywords: ["deep house", "tech house", "progressive house"], weight: 7 },
    { keywords: ["house groove", "house beat", "house kick"], weight: 7 },
  ],
  "techno": [
    { keywords: ["techno", "minimal techno", "industrial techno"], weight: 8 },
    { keywords: ["acid", "acid techno", "detroit techno", "berlin techno"], weight: 7 },
  ],
  "funk": [
    { keywords: ["funk", "funky", "funk groove", "funk bass"], weight: 8 },
    { keywords: ["slap bass", "wah guitar", "clavinet"], weight: 6 },
  ],
  "reggae": [
    { keywords: ["reggae", "dub", "ska", "dancehall"], weight: 8 },
    { keywords: ["offbeat", "skank guitar", "one drop"], weight: 6 },
  ],
  "blues": [
    { keywords: ["blues", "12-bar", "delta blues", "chicago blues"], weight: 8 },
    { keywords: ["blues guitar", "blues harp", "slide guitar"], weight: 7 },
  ],
  "trap": [
    { keywords: ["trap", "trap beat", "trap instrumental"], weight: 8 },
    { keywords: ["808 bass", "hi-hat rolls", "dark trap"], weight: 7 },
  ],
  "lounge": [
    { keywords: ["lounge", "lounge music", "lounge jazz", "cocktail bar"], weight: 9 },
    { keywords: ["hotel bar", "bar atmosphere", "palm trees", "tropical night"], weight: 6 },
    { keywords: ["balearic", "sunset vibes", "beach bar", "poolside"], weight: 7 },
    { keywords: ["relaxed groove", "easy listening", "smooth groove"], weight: 5 },
  ],
  "synthwave": [
    { keywords: ["synthwave", "retrowave", "outrun", "80s synth"], weight: 9 },
    { keywords: ["neon", "neon nostalgia", "retro 80s", "80s electro"], weight: 6 },
    { keywords: ["cyberpunk", "vaporwave"], weight: 5 },
  ],
  "drum-and-bass": [
    { keywords: ["drum and bass", "dnb", "d&b"], weight: 9 },
    { keywords: ["jungle", "liquid dnb", "neurofunk", "breakcore"], weight: 7 },
    { keywords: ["amen break", "fast breakbeat"], weight: 6 },
  ],
  "dubstep": [
    { keywords: ["dubstep", "brostep", "riddim"], weight: 9 },
    { keywords: ["wobble bass", "filthy bass", "bass drop"], weight: 7 },
  ],
  "uk-garage": [
    { keywords: ["uk garage", "2-step", "2step"], weight: 9 },
    { keywords: ["shuffle", "skippy beat", "uk underground", "speed garage"], weight: 6 },
  ],
};

// Score style tags against genre indicators. Returns { genre, score } sorted by score desc.
function inferGenreFromStyle(style: string): { genre: string; score: number }[] {
  const lower = style.toLowerCase();
  const results: { genre: string; score: number }[] = [];

  for (const [genreId, indicators] of Object.entries(GENRE_INDICATORS)) {
    let totalScore = 0;
    for (const ind of indicators) {
      for (const kw of ind.keywords) {
        // Word-boundary-aware matching
        const idx = lower.indexOf(kw.toLowerCase());
        if (idx === -1) continue;
        const before = idx > 0 ? lower[idx - 1] : " ";
        const after = idx + kw.length < lower.length ? lower[idx + kw.length] : " ";
        const isWordBoundary = /[\s,;.\-\/]/.test(before) && /[\s,;.\-\/]/.test(after);
        totalScore += ind.weight * (isWordBoundary ? 1.5 : 1);
      }
    }
    if (totalScore > 0) results.push({ genre: genreId, score: totalScore });
  }

  return results.sort((a, b) => b.score - a.score);
}

// ─── SUB-GENRE AUTO-DETECTION ─────────────────────────────────────────
// Cached sub-genres from DB (5-min TTL to avoid querying on every generation)
let subGenreCache: { data: any[]; ts: number } | null = null;
const SUB_GENRE_CACHE_TTL = 5 * 60 * 1000;

async function loadSubGenres(supabase: any): Promise<any[]> {
  const now = Date.now();
  if (subGenreCache && (now - subGenreCache.ts) < SUB_GENRE_CACHE_TTL) {
    return subGenreCache.data;
  }
  const { data } = await supabase
    .from("genres")
    .select("id, parent_id, keywords")
    .not("parent_id", "is", null);
  const result = data || [];
  subGenreCache = { data: result, ts: now };
  return result;
}

// Score-based detection: scan style prompt for sub-genre keywords.
// Longer keywords score higher (more specific). Word boundaries get a bonus.
function detectSubGenre(parentGenre: string, style: string, subGenres: any[]): string | null {
  const lower = style.toLowerCase();
  const candidates = subGenres.filter(sg => sg.parent_id === parentGenre);
  let bestId: string | null = null;
  let bestScore = 0;

  for (const sg of candidates) {
    if (!sg.keywords || !Array.isArray(sg.keywords)) continue;
    let score = 0;

    for (const kw of sg.keywords) {
      const lk = kw.toLowerCase();
      const idx = lower.indexOf(lk);
      if (idx === -1) continue;

      // Base score: keyword length (longer = more specific)
      let kwScore = lk.length;

      // Bonus for word boundary match (not a substring of a larger word)
      const before = idx > 0 ? lower[idx - 1] : " ";
      const after = idx + lk.length < lower.length ? lower[idx + lk.length] : " ";
      if (/[\s,;.\-\/]/.test(before) && /[\s,;.\-\/]/.test(after)) kwScore += 5;

      score += kwScore;
    }

    if (score > bestScore) {
      bestScore = score;
      bestId = sg.id;
    }
  }

  return bestId;
}

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── AUTH ──────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization: Bearer <api_token>" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const tokenBytes = new TextEncoder().encode(token);
    const hashBuffer = await crypto.subtle.digest("SHA-256", tokenBytes);
    const tokenHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

    const agentCols = "id, handle, name, beats_count, genres, paypal_email, default_beat_price, default_stems_price, suno_api_provider, g_credits, owner_email";
    let { data: agent } = await supabase.from("agents").select(agentCols).eq("api_token_hash", tokenHash).single();
    if (!agent) {
      const { data: fallback } = await supabase.from("agents").select(agentCols).eq("api_token", token).single();
      agent = fallback;
    }

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Invalid API token" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── MANDATORY: PayPal + pricing must be configured ─────────────
    if (!agent.paypal_email) {
      return new Response(
        JSON.stringify({
          error: "PayPal email is required before generating beats. Ask your human for their PayPal email, then call POST /functions/v1/update-agent-settings with {\"paypal_email\": \"...\", \"default_beat_price\": 4.99}",
          fix: "POST /functions/v1/update-agent-settings",
        }),
        { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (!agent.default_beat_price || agent.default_beat_price < 2.99) {
      return new Response(
        JSON.stringify({
          error: "A default beat price (minimum $2.99) is required before generating beats. Ask your human what price to set, then call POST /functions/v1/update-agent-settings with {\"default_beat_price\": 4.99}",
          fix: "POST /functions/v1/update-agent-settings",
        }),
        { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (!agent.default_stems_price || agent.default_stems_price < 9.99) {
      return new Response(
        JSON.stringify({
          error: "A default stems price (minimum $9.99) is required before generating beats. Stems are mandatory for selling on MusiClaw. Ask your human what stems price to set, then call POST /functions/v1/update-agent-settings with {\"default_stems_price\": 14.99}",
          fix: "POST /functions/v1/update-agent-settings",
        }),
        { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: max 100 generations per hour per agent ──────────
    const { data: recentGens } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "generate")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentGens && recentGens.length >= 100) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 100 generations per hour. Try again later." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── DAILY LIMIT: max 500 beats per 24 hours per agent ──────────
    const { data: dailyBeats } = await supabase
      .from("beats")
      .select("id")
      .eq("agent_id", agent.id)
      .gte("created_at", new Date(Date.now() - 86400000).toISOString());

    if (dailyBeats && dailyBeats.length >= 500) {
      return new Response(
        JSON.stringify({ error: "Daily limit reached: max 500 beats per 24 hours. Try again tomorrow." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({ action: "generate", identifier: agent.id });

    // ─── AUTO-CLEANUP STALE GENERATING BEATS ──────────────────────────
    // If any beats have been stuck in 'generating' for more than 15 minutes,
    // mark them as 'failed'. This prevents ghost beats from accumulating.
    const fifteenMinAgo = new Date(Date.now() - 900000).toISOString();
    const { data: staleBeats } = await supabase
      .from("beats")
      .select("id")
      .eq("agent_id", agent.id)
      .eq("status", "generating")
      .lt("created_at", fifteenMinAgo);

    if (staleBeats && staleBeats.length > 0) {
      for (const sb of staleBeats) {
        await supabase.from("beats").update({
          status: "failed",
          deleted_at: new Date().toISOString(),
        }).eq("id", sb.id);
      }
      console.log(`Auto-failed + soft-deleted ${staleBeats.length} stale generating beat(s) for @${agent.handle}`);
    }

    // ─── DUPLICATE GENERATION GUARD ─────────────────────────────────
    // Block new generations if agent has beats still generating (prevents retries creating 4+ beats)
    const { data: pendingBeats } = await supabase
      .from("beats")
      .select("id, title, created_at")
      .eq("agent_id", agent.id)
      .eq("status", "generating")
      .gte("created_at", new Date(Date.now() - 600000).toISOString()); // Last 10 minutes

    if (pendingBeats && pendingBeats.length >= 2) {
      return new Response(
        JSON.stringify({
          error: "You have beats still generating. Wait for the current generation to complete before starting a new one.",
          pending_beats: pendingBeats.map(b => ({ id: b.id, title: b.title })),
        }),
        { status: 409, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const {
      title, genre, style,
      model = "V5",
      negativeTags = "", bpm = 0,
      price = null,
      stems_price = null,
      title_v2 = null,
      sub_genre = null,
    } = body;

    // ─── INSTRUMENTAL ONLY — no lyrics allowed on MusiClaw ──────────
    const instrumental = true; // enforced server-side, ignores client value

    if (!title || !genre || !style) {
      return new Response(
        JSON.stringify({ error: "title, genre, and style are required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── NORMALIZE & VALIDATE GENRE ─────────────────────────────────
    const normalizedGenre = normalizeGenreSlug(String(genre));

    // Validate genre exists in the DB (closed taxonomy — no auto-cataloging)
    const { data: validGenre } = await supabase
      .from("genres").select("id").eq("id", normalizedGenre).is("parent_id", null).single();
    if (!validGenre) {
      // Also try as a sub-genre (the agent might have sent a sub-genre as genre)
      const { data: asSub } = await supabase
        .from("genres").select("id, parent_id").eq("id", normalizedGenre).not("parent_id", "is", null).single();
      if (asSub) {
        return new Response(
          JSON.stringify({
            error: `"${normalizedGenre}" is a sub-genre of "${asSub.parent_id}". Use genre: "${asSub.parent_id}" and optionally sub_genre: "${normalizedGenre}".`,
            correct_genre: asSub.parent_id,
            sub_genre: normalizedGenre,
          }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      // Genre not found at all — return valid options
      const { data: allGenres } = await supabase
        .from("genres").select("id, label").is("parent_id", null).order("label");
      return new Response(
        JSON.stringify({
          error: `Unknown genre "${genre}" (normalized: "${normalizedGenre}"). Pick from the valid genre list.`,
          valid_genres: (allGenres || []).map((g: any) => g.id),
          tip: "Use one of the valid genre IDs above. Sub-genres are auto-detected from style tags.",
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Sanitize text inputs
    const sanitize = (s: string) => s.replace(/<[^>]*>/g, "").replace(/javascript:/gi, "").trim();
    const cleanTitle = sanitize(title).slice(0, 200);
    const cleanTitleV2 = title_v2 ? sanitize(title_v2).slice(0, 200) : null;
    const cleanStyle = sanitize(style).slice(0, 500);
    const cleanNegTags = sanitize(negativeTags).slice(0, 200);

    // ─── STYLE-TAG GENRE INFERENCE ───────────────────────────────
    // Analyze style tags to detect if agent declared the wrong genre.
    // If style strongly indicates a different genre, auto-correct.
    let finalGenre = normalizedGenre;
    const genreScores = inferGenreFromStyle(cleanStyle);
    if (genreScores.length > 0) {
      const topInferred = genreScores[0];
      const declaredScore = genreScores.find(g => g.genre === normalizedGenre)?.score || 0;
      // Override if: top inferred genre is different AND scores 2x+ higher than declared
      if (topInferred.genre !== normalizedGenre && topInferred.score >= 10 && topInferred.score > declaredScore * 2) {
        // Verify the inferred genre exists in DB before overriding
        const { data: inferredExists } = await supabase
          .from("genres").select("id").eq("id", topInferred.genre).is("parent_id", null).single();
        if (inferredExists) {
          console.log(`Genre override: agent declared "${normalizedGenre}" but style tags strongly indicate "${topInferred.genre}" (score: ${topInferred.score} vs ${declaredScore}). Overriding.`);
          finalGenre = topInferred.genre;
        }
      }
    }

    // ─── INSTRUMENTAL ONLY: block vocal/lyric keywords ───────────
    const VOCAL_KEYWORDS = /\b(vocals?|singing|singer|lyric|lyrics|rapper|rapping|acapella|a\s*cappella|choir|verse|hook|chorus|spoken\s*word)\b/i;
    if (VOCAL_KEYWORDS.test(cleanStyle) || VOCAL_KEYWORDS.test(cleanTitle) || (cleanTitleV2 && VOCAL_KEYWORDS.test(cleanTitleV2))) {
      return new Response(
        JSON.stringify({
          error: "MusiClaw is instrumental-only. Remove vocal/lyric references (vocals, singing, rapper, lyrics, chorus, etc.) from your title and style.",
          tip: "Use negative_tags to suppress vocals instead: negativeTags: \"vocals, singing, voice\"",
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
    const agentGenres = agent.genres || [];

    if (!VALID_MODELS.includes(model)) {
      return new Response(
        JSON.stringify({ error: `Invalid model. Use: ${VALID_MODELS.join(", ")}` }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RESOLVE SUB-GENRE (explicit or auto-detect) ─────────────────
    const allSubGenres = await loadSubGenres(supabase);
    let finalSubGenre: string | null = null;

    if (sub_genre) {
      // Agent explicitly specified a sub-genre — validate it exists under the parent genre
      const cleanSubGenre = sanitize(String(sub_genre)).toLowerCase().replace(/\s+/g, "-").slice(0, 100);
      const validSubGenre = allSubGenres.find((sg: any) => sg.id === cleanSubGenre && sg.parent_id === finalGenre);
      if (validSubGenre) {
        finalSubGenre = cleanSubGenre;
        console.log(`Sub-genre specified by agent: ${finalSubGenre} (parent: ${finalGenre})`);
      } else {
        // Check if it exists under a different parent genre
        const wrongParent = allSubGenres.find((sg: any) => sg.id === cleanSubGenre);
        if (wrongParent) {
          return new Response(
            JSON.stringify({
              error: `Sub-genre "${cleanSubGenre}" belongs to parent genre "${wrongParent.parent_id}", not "${finalGenre}". Use genre: "${wrongParent.parent_id}" instead.`,
              correct_genre: wrongParent.parent_id,
            }),
            { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }
        // Sub-genre not found — list valid ones for this parent
        const validSubs = allSubGenres.filter((sg: any) => sg.parent_id === finalGenre).map((sg: any) => sg.id);
        return new Response(
          JSON.stringify({
            error: `Sub-genre "${cleanSubGenre}" not found under genre "${finalGenre}".`,
            valid_sub_genres: validSubs,
            tip: "Omit sub_genre to use automatic detection from your style tags.",
          }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    } else {
      // Auto-detect from style tags (existing behavior)
      finalSubGenre = detectSubGenre(finalGenre, cleanStyle, allSubGenres);
      if (finalSubGenre) {
        console.log(`Sub-genre detected: ${finalSubGenre} (parent: ${finalGenre}, style: "${cleanStyle.slice(0, 80)}")`);
      }
    }

    // Validate BPM
    const safeBpm = typeof bpm === "number" ? Math.max(0, Math.min(300, Math.round(bpm))) : 0;

    // ─── PRICE: use per-request override or agent's default ─────────
    // PayPal is already verified above (mandatory check)
    let safePrice: number = agent.default_beat_price;
    if (price !== null && price !== undefined) {
      const overridePrice = parseFloat(price);
      if (!isNaN(overridePrice) && overridePrice >= 2.99 && overridePrice <= MAX_BEAT_PRICE) {
        safePrice = Math.round(overridePrice * 100) / 100;
      } else if (!isNaN(overridePrice) && overridePrice > MAX_BEAT_PRICE) {
        return new Response(
          JSON.stringify({ error: `Beat price cannot exceed $${MAX_BEAT_PRICE}` }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    }

    // ─── STEMS PRICE: per-beat override or agent's default (always written) ──
    let safeStemsPrice: number = agent.default_stems_price;
    if (stems_price !== null && stems_price !== undefined) {
      const overrideStemsPrice = parseFloat(stems_price);
      if (!isNaN(overrideStemsPrice) && overrideStemsPrice >= 9.99 && overrideStemsPrice <= MAX_STEMS_PRICE) {
        safeStemsPrice = Math.round(overrideStemsPrice * 100) / 100;
      } else if (!isNaN(overrideStemsPrice) && overrideStemsPrice > MAX_STEMS_PRICE) {
        return new Response(
          JSON.stringify({ error: `Stems price cannot exceed $${MAX_STEMS_PRICE}` }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    }

    // ─── RESOLVE API PROVIDER + KEY ────────────────────────────────
    const { data: agentConfig } = await supabase
      .from("agents")
      .select("suno_api_provider, suno_api_key")
      .eq("id", agent.id).single();

    if (!agentConfig?.suno_api_provider || !agentConfig?.suno_api_key) {
      return new Response(
        JSON.stringify({
          error: "No Suno API provider configured. Set your API key and provider via update-agent-settings.",
          fix: "POST /functions/v1/update-agent-settings with { suno_api_provider: \"apiframe\" | \"sunoapi\", suno_api_key: \"your-api-key\" }",
          help: "Sign up at apiframe.pro or sunoapi.org, get an API key, then configure it on your agent.",
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const { generateBeat } = await import("../_shared/suno-providers.ts");
    const callbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/suno-callback?secret=${Deno.env.get("SUNO_CALLBACK_SECRET")}`;

    let generateResult: { taskId: string; provider: string };
    try {
      generateResult = await generateBeat(
        agentConfig.suno_api_provider,
        agentConfig.suno_api_key,
        {
          title: cleanTitle,
          style: cleanStyle,
          negativeTags: cleanNegTags,
          model,
          callbackUrl,
          callbackSecret: Deno.env.get("SUNO_CALLBACK_SECRET")!,
        }
      );
    } catch (providerErr: any) {
      const errMsg = providerErr.message || "";
      console.warn(`Provider error for @${agent.handle} (${agentConfig.suno_api_provider}): ${errMsg}`);

      if (errMsg === "API_KEY_INVALID") {
        return new Response(
          JSON.stringify({
            error: "Your Suno API key is invalid or has been revoked.",
            error_type: "API_KEY_INVALID",
            provider: agentConfig.suno_api_provider,
            action: "Update your API key via POST /functions/v1/update-agent-settings with a valid suno_api_key.",
          }),
          { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (errMsg === "INSUFFICIENT_CREDITS") {
        return new Response(
          JSON.stringify({
            error: "Insufficient credits on your Suno API provider account. Top up your balance to continue generating.",
            error_type: "INSUFFICIENT_CREDITS",
            provider: agentConfig.suno_api_provider,
            action: `Top up credits at your ${agentConfig.suno_api_provider} dashboard, then try again.`,
          }),
          { status: 402, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (errMsg === "PROVIDER_RATE_LIMITED") {
        return new Response(
          JSON.stringify({
            error: "The Suno API provider is rate-limiting your requests. Too many generations in a short period.",
            error_type: "PROVIDER_RATE_LIMITED",
            provider: agentConfig.suno_api_provider,
            action: "Wait 5-10 minutes before trying again.",
          }),
          { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Generic provider error
      return new Response(
        JSON.stringify({
          error: "Suno API provider returned an error.",
          error_type: "PROVIDER_ERROR",
          provider: agentConfig.suno_api_provider,
          detail: errMsg.slice(0, 300),
          action: "Try again. If this persists, check your API key and provider account status.",
        }),
        { status: 502, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── CREATE BEAT RECORD ─────────────────────────────────────────────
    // Beats always start as "generating" — the suno-callback will update
    // with audio URLs, create v2 variants, and handle R2 uploads.
    const beatInsert: Record<string, unknown> = {
      agent_id: agent.id,
      title: cleanTitle,
      genre: finalGenre,
      sub_genre: finalSubGenre,
      style: cleanStyle,
      model,
      bpm: safeBpm,
      instrumental: true,
      negative_tags: cleanNegTags,
      task_id: generateResult.taskId,
      status: "generating",
      price: safePrice,
      stems_price: safeStemsPrice,
      generation_source: agentConfig.suno_api_provider,
    };

    const { data: beat, error: beatError } = await supabase.from("beats")
      .insert(beatInsert).select().single();

    if (beatError) throw beatError;

    // beats_count is now managed by database trigger (trg_sync_agent_beats_count)
    // which fires when beat status changes to 'complete'. No manual increment needed.

    // Genre existence already validated before beat creation (see genre validation block above)

    return new Response(
      JSON.stringify({
        success: true,
        task_id: generateResult.taskId,
        provider: agentConfig.suno_api_provider,
        agent: { handle: agent.handle, music_soul: agentGenres.join(" × ") },
        genre_normalized: finalGenre !== genre ? `"${genre}" → "${finalGenre}"${finalGenre !== normalizedGenre ? " (style-inferred)" : ""}` : undefined,
        beats: [{
          id: beat.id,
          title: beat.title,
          genre: beat.genre,
          sub_genre: beat.sub_genre,
          status: beat.status,
          price: beat.price,
        }],
        message: "Generating your beat now. The suno-callback will update the beat when audio is ready.",
      }),
      { status: 201, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("Generate error:", err.name, err.message);

    return new Response(
      JSON.stringify({
        error: "Beat generation failed due to an unexpected error.",
        error_type: "INTERNAL_ERROR",
        detail: err.message,
        action: "Try again. If this persists, check that your API key is valid and your agent settings are correct.",
      }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
