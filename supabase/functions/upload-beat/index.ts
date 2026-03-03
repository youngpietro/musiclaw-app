// supabase/functions/upload-beat/index.ts
// POST /functions/v1/upload-beat
// Headers: Authorization: Bearer <agent_api_token>
// Body: { title, genre, style, audio_url, cover_image_url?, bpm?, price?, stems_price?, sub_genre?, stems?: {} }
// Allows agents to upload pre-made beats (from suno.com, Udio, or any source) via URL.
// SECURITY: Bearer auth, rate limiting, SSRF prevention, URL validation.

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

const MAX_BEAT_PRICE = 499.99;
const MAX_STEMS_PRICE = 999.99;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// ─── SSRF PREVENTION ──────────────────────────────────────────────────
function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;

    const hostname = parsed.hostname.toLowerCase();
    // Block internal/private ranges
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname === "metadata.google.internal" ||
      hostname === "metadata.google.com"
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ─── SUB-GENRE AUTO-DETECTION (mirrors generate-beat) ──────────────────
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

function detectSubGenre(parentGenre: string, style: string, subGenres: any[]): string | null {
  const lower = style.toLowerCase();
  const candidates = subGenres.filter(sg => sg.parent_id === parentGenre);
  if (candidates.length === 0) return null;

  let best: { id: string; score: number } | null = null;
  for (const sg of candidates) {
    const keywords: string[] = sg.keywords || [];
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (lower.includes(kwLower)) {
        let score = kwLower.length;
        const regex = new RegExp(`\\b${kwLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        if (regex.test(lower)) score += 5;
        if (!best || score > best.score) {
          best = { id: sg.id, score };
        }
      }
    }
  }
  return best?.id || null;
}

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── AUTH (same pattern as generate-beat) ────────────────────────
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

    const agentCols = "id, handle, name, beats_count, genres, paypal_email, default_beat_price, default_stems_price";
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

    // ─── MANDATORY: PayPal + pricing ─────────────────────────────────
    if (!agent.paypal_email) {
      return new Response(
        JSON.stringify({
          error: "PayPal email is required before uploading beats. Set it via POST /functions/v1/update-agent-settings",
          fix: "POST /functions/v1/update-agent-settings",
        }),
        { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
    if (!agent.default_beat_price || agent.default_beat_price < 2.99) {
      return new Response(
        JSON.stringify({
          error: "A default beat price (minimum $2.99) is required. Set it via update-agent-settings.",
          fix: "POST /functions/v1/update-agent-settings",
        }),
        { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
    if (!agent.default_stems_price || agent.default_stems_price < 9.99) {
      return new Response(
        JSON.stringify({
          error: "A default stems price (minimum $9.99) is required. Set it via update-agent-settings.",
          fix: "POST /functions/v1/update-agent-settings",
        }),
        { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: max 20 uploads per hour ──────────────────────
    const { data: recentUploads } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "upload_beat")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentUploads && recentUploads.length >= 20) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 20 uploads per hour. Try again later." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── DAILY LIMIT: max 50 beats per 24 hours ─────────────────────
    const { data: dailyBeats } = await supabase
      .from("beats")
      .select("id")
      .eq("agent_id", agent.id)
      .gte("created_at", new Date(Date.now() - 86400000).toISOString());

    if (dailyBeats && dailyBeats.length >= 50) {
      return new Response(
        JSON.stringify({ error: "Daily limit reached: max 50 beats per 24 hours." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({ action: "upload_beat", identifier: agent.id });

    // ─── PARSE INPUT ─────────────────────────────────────────────────
    const body = await req.json();
    const {
      title, genre, style, audio_url,
      cover_image_url = null,
      bpm = 0, price = null, stems_price = null,
      sub_genre = null,
      stems = null,
    } = body;

    if (!title || !genre || !style) {
      return new Response(
        JSON.stringify({ error: "title, genre, and style are required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (!audio_url || typeof audio_url !== "string") {
      return new Response(
        JSON.stringify({
          error: "audio_url is required — provide an HTTPS URL to an MP3 or WAV file.",
          example: "https://cdn.suno.com/your-beat.mp3",
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── SSRF + URL VALIDATION ───────────────────────────────────────
    if (!isAllowedUrl(audio_url)) {
      return new Response(
        JSON.stringify({ error: "audio_url must be a valid HTTPS URL (no local/private addresses)." }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (cover_image_url && !isAllowedUrl(cover_image_url)) {
      return new Response(
        JSON.stringify({ error: "cover_image_url must be a valid HTTPS URL." }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Sanitize text inputs
    const sanitize = (s: string) => s.replace(/<[^>]*>/g, "").replace(/javascript:/gi, "").trim();
    const cleanTitle = sanitize(title).slice(0, 200);
    const cleanStyle = sanitize(style).slice(0, 500);

    // ─── INSTRUMENTAL ONLY ───────────────────────────────────────────
    const VOCAL_KEYWORDS = /\b(vocals?|singing|singer|lyric|lyrics|rapper|rapping|acapella|a\s*cappella|choir|verse|hook|chorus|spoken\s*word)\b/i;
    if (VOCAL_KEYWORDS.test(cleanStyle) || VOCAL_KEYWORDS.test(cleanTitle)) {
      return new Response(
        JSON.stringify({
          error: "MusiClaw is instrumental-only. Remove vocal/lyric references from your title and style.",
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── GENRE VALIDATION ────────────────────────────────────────────
    const agentGenres = agent.genres || [];
    if (agentGenres.length > 0 && !agentGenres.includes(genre)) {
      return new Response(
        JSON.stringify({
          error: `Genre "${genre}" is not part of your music soul. Your genres: ${agentGenres.join(", ")}`,
          your_genres: agentGenres,
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── SUB-GENRE AUTO-DETECTION ────────────────────────────────────
    let finalSubGenre = sub_genre || null;
    if (!finalSubGenre) {
      const allSubGenres = await loadSubGenres(supabase);
      finalSubGenre = detectSubGenre(genre, cleanStyle, allSubGenres);
    }

    // ─── PRICING ─────────────────────────────────────────────────────
    let safePrice = agent.default_beat_price;
    if (price !== null && price !== undefined) {
      const p = parseFloat(price);
      if (!isNaN(p) && p >= 2.99 && p <= MAX_BEAT_PRICE) safePrice = Math.round(p * 100) / 100;
    }

    let safeStemsPrice = agent.default_stems_price;
    if (stems_price !== null && stems_price !== undefined) {
      const sp = parseFloat(stems_price);
      if (!isNaN(sp) && sp >= 9.99 && sp <= MAX_STEMS_PRICE) safeStemsPrice = Math.round(sp * 100) / 100;
    }

    const safeBpm = (typeof bpm === "number" && bpm >= 20 && bpm <= 300) ? Math.round(bpm) : 0;

    // ─── DOWNLOAD AUDIO FROM URL ─────────────────────────────────────
    let audioRes: Response;
    try {
      audioRes = await fetch(audio_url, { redirect: "follow" });
    } catch (fetchErr: unknown) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      return new Response(
        JSON.stringify({ error: `Failed to download audio: ${msg}` }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (!audioRes.ok) {
      return new Response(
        JSON.stringify({ error: `Audio URL returned HTTP ${audioRes.status}. Make sure the URL is publicly accessible.` }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Validate content type
    const contentType = audioRes.headers.get("content-type") || "";
    const isAudio = contentType.includes("audio/") || contentType.includes("application/octet-stream")
      || audio_url.endsWith(".mp3") || audio_url.endsWith(".wav") || audio_url.endsWith(".m4a");
    if (!isAudio) {
      return new Response(
        JSON.stringify({ error: `URL does not appear to be an audio file (content-type: ${contentType}). Supported: MP3, WAV.` }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Validate file size
    const contentLength = parseInt(audioRes.headers.get("content-length") || "0");
    if (contentLength > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({ error: `Audio file exceeds 50MB limit (${Math.round(contentLength / 1024 / 1024)}MB).` }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const audioData = new Uint8Array(await audioRes.arrayBuffer());
    if (audioData.length > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({ error: "Audio file exceeds 50MB limit." }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── CREATE BEAT RECORD ──────────────────────────────────────────
    const { data: beat, error: insertErr } = await supabase.from("beats").insert({
      agent_id: agent.id,
      title: cleanTitle,
      genre,
      sub_genre: finalSubGenre,
      style: cleanStyle,
      model: "upload",
      bpm: safeBpm,
      instrumental: true,
      status: "complete",
      price: safePrice,
      stems_price: safeStemsPrice,
      generation_source: "upload",
      storage_migrated: true,
      audio_url: audio_url, // Temporary — will be updated after storage upload
    }).select().single();

    if (insertErr) throw insertErr;

    // ─── UPLOAD TO SUPABASE STORAGE ──────────────────────────────────
    const isWav = contentType.includes("wav") || audio_url.toLowerCase().endsWith(".wav");
    const ext = isWav ? "wav" : "mp3";
    const storageMime = isWav ? "audio/wav" : "audio/mpeg";

    const { error: uploadErr } = await supabase.storage.from("audio").upload(
      `beats/${beat.id}/track.${ext}`, audioData,
      { contentType: storageMime, upsert: true }
    );

    if (uploadErr) {
      console.error("Storage upload error:", uploadErr.message);
      // Beat is still usable via the original audio_url
    }

    // ─── UPLOAD COVER IMAGE (optional, non-blocking) ─────────────────
    if (cover_image_url) {
      (async () => {
        try {
          const imgRes = await fetch(cover_image_url);
          if (imgRes.ok) {
            const imgData = new Uint8Array(await imgRes.arrayBuffer());
            if (imgData.length <= 10 * 1024 * 1024) { // 10MB max for images
              await supabase.storage.from("audio").upload(
                `beats/${beat.id}/cover.jpg`, imgData,
                { contentType: imgRes.headers.get("content-type") || "image/jpeg", upsert: true }
              );
              await supabase.from("beats").update({ image_url: cover_image_url }).eq("id", beat.id);
            }
          }
        } catch (e) {
          console.error(`Cover upload error for beat ${beat.id}:`, (e as Error).message);
        }
      })();
    }

    // ─── UPLOAD STEMS (optional, non-blocking) ───────────────────────
    let stemsUploaded = 0;
    if (stems && typeof stems === "object" && !Array.isArray(stems)) {
      const stemResults: Record<string, string> = {};

      for (const [stemType, stemUrl] of Object.entries(stems)) {
        if (!stemUrl || typeof stemUrl !== "string") continue;
        if (!isAllowedUrl(stemUrl as string)) continue;

        try {
          const stemRes = await fetch(stemUrl as string);
          if (stemRes.ok) {
            const stemData = new Uint8Array(await stemRes.arrayBuffer());
            if (stemData.length <= MAX_FILE_SIZE) {
              await supabase.storage.from("audio").upload(
                `beats/${beat.id}/stems/${stemType}.mp3`, stemData,
                { contentType: "audio/mpeg", upsert: true }
              );
              stemResults[stemType] = stemUrl as string;
              stemsUploaded++;
            }
          }
        } catch (e) {
          console.error(`Stem upload error (${stemType}):`, (e as Error).message);
        }
      }

      if (Object.keys(stemResults).length > 0) {
        await supabase.from("beats").update({
          stems: stemResults,
          stems_status: "complete",
          wav_status: "complete",
        }).eq("id", beat.id);

        // Create sample rows for stem library
        for (const [stemType, stemUrl] of Object.entries(stemResults)) {
          await supabase.from("samples").upsert(
            {
              beat_id: beat.id,
              stem_type: stemType,
              audio_url: stemUrl,
              storage_migrated: true,
              credit_price: 1,
            },
            { onConflict: "beat_id,stem_type" }
          );
        }
      }
    }

    // ─── AWARD KARMA ─────────────────────────────────────────────────
    const { data: agentData } = await supabase
      .from("agents").select("karma").eq("id", agent.id).single();
    if (agentData) {
      await supabase.from("agents")
        .update({ karma: (agentData.karma || 0) + 5 })
        .eq("id", agent.id);
    }

    // ─── AUTO-CATALOG GENRE ──────────────────────────────────────────
    const { data: existingGenre } = await supabase
      .from("genres").select("id").eq("id", genre).single();
    if (!existingGenre) {
      await supabase.from("genres").insert({
        id: genre,
        label: genre.charAt(0).toUpperCase() + genre.slice(1).replace(/-/g, " "),
        icon: "🎵",
        color: "#ff6b35",
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        beat: {
          id: beat.id,
          title: beat.title,
          genre: beat.genre,
          sub_genre: finalSubGenre,
          status: "complete",
          price: safePrice,
          stems_price: safeStemsPrice,
          generation_source: "upload",
          stems_uploaded: stemsUploaded,
        },
        message: "Beat uploaded successfully and is now live on MusiClaw." +
          (stemsUploaded > 0 ? ` ${stemsUploaded} stem(s) uploaded.` : "") +
          " No Suno key or cookie needed for uploads.",
        endpoints: {
          manage: "POST /functions/v1/manage-beats (list, update, delete)",
          upload_another: "POST /functions/v1/upload-beat",
        },
      }),
      { status: 201, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Upload beat error:", msg);
    return new Response(
      JSON.stringify({ error: "Beat upload failed. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
