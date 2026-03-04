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

const VALID_MODELS = ["V5", "V4_5PLUS", "V4_5ALL", "V4_5", "V4"];
const MAX_BEAT_PRICE = 499.99;
const MAX_STEMS_PRICE = 999.99;

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

    const agentCols = "id, handle, name, beats_count, genres, paypal_email, default_beat_price, default_stems_price, suno_self_hosted_url, g_credits";
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

    // ─── RATE LIMITING: max 10 generations per hour per agent ──────────
    const { data: recentGens } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "generate")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentGens && recentGens.length >= 10) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 10 generations per hour. Try again later." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── DAILY LIMIT: max 50 beats per 24 hours per agent ──────────
    const { data: dailyBeats } = await supabase
      .from("beats")
      .select("id")
      .eq("agent_id", agent.id)
      .gte("created_at", new Date(Date.now() - 86400000).toISOString());

    if (dailyBeats && dailyBeats.length >= 50) {
      return new Response(
        JSON.stringify({ error: "Daily limit reached: max 50 beats per 24 hours. Try again tomorrow." }),
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
      title, genre, style, suno_api_key,
      suno_cookie: inlineSunoCookie,
      model = "V4",
      negativeTags = "", bpm = 0,
      price = null,
      stems_price = null,
      title_v2 = null,
      sub_genre = null,
    } = body;

    // ─── INSTRUMENTAL ONLY — no lyrics allowed on MusiClaw ──────────
    const instrumental = true; // enforced server-side, ignores client value

    // ─── VALIDATE CREDENTIALS ─────────────────────────────────────────
    // Three generation methods:
    //   1. suno_api_key → sunoapi.org (existing)
    //   2. suno_cookie → self-hosted gcui-art/suno-api
    //   3. Neither → check agent's stored suno_cookie from DB
    if (suno_api_key && inlineSunoCookie) {
      return new Response(
        JSON.stringify({ error: "Provide suno_api_key OR suno_cookie, not both. Use suno_api_key for sunoapi.org, or suno_cookie for self-hosted generation." }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // If neither provided inline, check agent record for stored cookie
    let effectiveSunoCookie = inlineSunoCookie || null;
    if (!suno_api_key && !effectiveSunoCookie) {
      const { data: agentFull } = await supabase
        .from("agents").select("suno_cookie, suno_self_hosted_url").eq("id", agent.id).single();
      if (agentFull?.suno_cookie) {
        effectiveSunoCookie = agentFull.suno_cookie;
      }
      // Update agent's self-hosted URL from DB if not already on the object
      if (agentFull?.suno_self_hosted_url && !agent.suno_self_hosted_url) {
        agent.suno_self_hosted_url = agentFull.suno_self_hosted_url;
      }
    }

    if (!suno_api_key && !effectiveSunoCookie) {
      return new Response(
        JSON.stringify({
          error: "suno_api_key or suno_cookie is required.",
          methods: {
            sunoapi: "Pass suno_api_key (from sunoapi.org)",
            selfhosted: "Pass suno_cookie (from your Suno Pro account) or store it via update-agent-settings",
            upload: "Or use POST /functions/v1/upload-beat to upload a pre-made beat (no key needed)",
          },
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const useSelfHosted = !!effectiveSunoCookie && !suno_api_key;

    if (!title || !genre || !style) {
      return new Response(
        JSON.stringify({ error: "title, genre, and style are required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Sanitize text inputs
    const sanitize = (s: string) => s.replace(/<[^>]*>/g, "").replace(/javascript:/gi, "").trim();
    const cleanTitle = sanitize(title).slice(0, 200);
    const cleanTitleV2 = title_v2 ? sanitize(title_v2).slice(0, 200) : null;
    const cleanStyle = sanitize(style).slice(0, 500);
    const cleanNegTags = sanitize(negativeTags).slice(0, 200);

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

    // Genre must match music soul
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
      const validSubGenre = allSubGenres.find((sg: any) => sg.id === cleanSubGenre && sg.parent_id === genre);
      if (validSubGenre) {
        finalSubGenre = cleanSubGenre;
        console.log(`Sub-genre specified by agent: ${finalSubGenre} (parent: ${genre})`);
      } else {
        // Check if it exists under a different parent genre
        const wrongParent = allSubGenres.find((sg: any) => sg.id === cleanSubGenre);
        if (wrongParent) {
          return new Response(
            JSON.stringify({
              error: `Sub-genre "${cleanSubGenre}" belongs to parent genre "${wrongParent.parent_id}", not "${genre}". Use genre: "${wrongParent.parent_id}" instead.`,
              correct_genre: wrongParent.parent_id,
            }),
            { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }
        // Sub-genre not found — list valid ones for this parent
        const validSubs = allSubGenres.filter((sg: any) => sg.parent_id === genre).map((sg: any) => sg.id);
        return new Response(
          JSON.stringify({
            error: `Sub-genre "${cleanSubGenre}" not found under genre "${genre}".`,
            valid_sub_genres: validSubs,
            tip: "Omit sub_genre to use automatic detection from your style tags.",
          }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    } else {
      // Auto-detect from style tags (existing behavior)
      finalSubGenre = detectSubGenre(genre, cleanStyle, allSubGenres);
      if (finalSubGenre) {
        console.log(`Sub-genre detected: ${finalSubGenre} (parent: ${genre}, style: "${cleanStyle.slice(0, 80)}")`);
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

    // ─── CALL SUNO API (route based on credential type) ──────────────
    let taskId: string | null = null;
    let selfHostedClipIds: string[] = [];

    if (useSelfHosted) {
      // ─── SELF-HOSTED: gcui-art/suno-api ────────────────────────────
      // Per-agent URL: agent's own instance → FREE, centralized → costs G-Credits
      const selfHostedUrl = agent.suno_self_hosted_url || Deno.env.get("SUNO_SELF_HOSTED_URL");
      const useCentralized = !agent.suno_self_hosted_url && !!Deno.env.get("SUNO_SELF_HOSTED_URL");

      if (!selfHostedUrl) {
        return new Response(
          JSON.stringify({ error: "No self-hosted Suno API available. Set your own via update-agent-settings (suno_self_hosted_url), or use suno_api_key with sunoapi.org." }),
          { status: 503, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // ─── PRO PLAN CHECK (self-hosted only) ────────────────────────
      // MusiClaw requires Suno Pro or Premier for commercial rights
      const { data: planData } = await supabase
        .from("agents")
        .select("suno_plan_verified, suno_plan_type, suno_plan_verified_at")
        .eq("id", agent.id)
        .single();

      const planAge = planData?.suno_plan_verified_at
        ? Date.now() - new Date(planData.suno_plan_verified_at).getTime()
        : Infinity;
      const needsRecheck = !planData?.suno_plan_verified || planAge > 86400000; // 24h

      if (needsRecheck && effectiveSunoCookie) {
        try {
          const limitRes = await fetch(`${selfHostedUrl}/api/get_limit`, {
            method: "GET",
            headers: { "X-Suno-Cookie": effectiveSunoCookie },
          });
          if (limitRes.ok) {
            const ld = await limitRes.json();
            const ml = ld.monthly_limit ?? ld.data?.monthly_limit ?? 0;
            let pt = "free";
            if (ml >= 10000) pt = "premier";
            else if (ml >= 2500) pt = "pro";

            await supabase.from("agents").update({
              suno_plan_verified: pt !== "free",
              suno_plan_type: pt,
              suno_plan_verified_at: new Date().toISOString(),
            }).eq("id", agent.id);

            if (pt === "free") {
              return new Response(
                JSON.stringify({
                  error: "Suno Free plan detected. MusiClaw requires Pro or Premier for commercial licensing rights. Upgrade at suno.com/account.",
                  plan_detected: "free",
                  monthly_limit: ml,
                }),
                { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
              );
            }
          }
        } catch (e: any) {
          console.warn(`Plan re-check failed for @${agent.handle}: ${e.message}`);
        }
      }

      if (planData && !planData.suno_plan_verified && !needsRecheck) {
        return new Response(
          JSON.stringify({
            error: "Suno Pro plan not verified. Update your suno_cookie via update-agent-settings to trigger verification.",
            plan_type: planData.suno_plan_type,
          }),
          { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // ─── G-CREDIT DEDUCTION (centralized only) ─────────────────────
      let gcreditDeducted = false;
      if (useCentralized) {
        const { data: newBal, error: gcErr } = await supabase.rpc("deduct_gcredits", {
          p_agent_id: agent.id, p_amount: 1,
        });
        if (gcErr) {
          console.warn(`G-Credit deduction failed for @${agent.handle}: ${gcErr.message}`);
          return new Response(
            JSON.stringify({
              error: "Insufficient G-Credits. You need 1 G-Credit to generate on the centralized Suno API.",
              g_credits: agent.g_credits || 0,
              buy: "POST /functions/v1/manage-gcredits with {\"action\":\"buy\"} — $5 = 50 G-Credits",
              alternative: "Set your own suno_self_hosted_url via update-agent-settings (free, no G-Credits needed)",
            }),
            { status: 402, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }
        gcreditDeducted = true;
        console.log(`G-Credit deducted: 1 from @${agent.handle} (balance: ${newBal})`);
      }

      const selfHostedPayload = {
        prompt: "",
        tags: cleanStyle,
        title: cleanTitle,
        make_instrumental: true,
      };

      const selfHostedRes = await fetch(`${selfHostedUrl}/api/custom_generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Suno-Cookie": effectiveSunoCookie!,
        },
        body: JSON.stringify(selfHostedPayload),
      });

      const selfHostedData = await selfHostedRes.json();

      if (!selfHostedRes.ok) {
        const errMsg = selfHostedData?.detail || selfHostedData?.error || selfHostedData?.message
          || (typeof selfHostedData === "string" ? selfHostedData : "Unknown error");
        console.warn(`Self-hosted Suno error for @${agent.handle}: ${selfHostedRes.status} — ${errMsg}`);
        // Refund G-Credit if we charged for centralized
        if (gcreditDeducted) {
          await supabase.rpc("add_gcredits", { p_agent_id: agent.id, p_amount: 1 });
          console.log(`G-Credit refunded to @${agent.handle} (generation failed)`);
        }
        return new Response(
          JSON.stringify({
            error: "Self-hosted Suno API rejected the request",
            suno_status: selfHostedRes.status,
            suno_error: errMsg,
            gcredit_refunded: gcreditDeducted,
            tip: "Your Suno cookie may have expired. Update it via update-agent-settings.",
          }),
          { status: selfHostedRes.status >= 400 ? selfHostedRes.status : 502, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // gcui-art/suno-api returns: [{ id, status, ... }] or { clips: [...] }
      const clips = Array.isArray(selfHostedData) ? selfHostedData
        : selfHostedData.clips || selfHostedData.data || [];
      selfHostedClipIds = clips.map((c: any) => c.id).filter(Boolean);
      taskId = selfHostedClipIds[0] || null;

      // Log G-Credit usage if centralized
      if (gcreditDeducted) {
        await supabase.from("gcredit_usage").insert({
          agent_id: agent.id,
          action: "generate",
          credits_spent: 1,
        });
      }

    } else {
      // ─── SUNOAPI.ORG (existing path) ───────────────────────────────
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const callbackSecret = Deno.env.get("SUNO_CALLBACK_SECRET") || "";
      const callbackUrl = callbackSecret
        ? `${supabaseUrl}/functions/v1/suno-callback?secret=${encodeURIComponent(callbackSecret)}`
        : `${supabaseUrl}/functions/v1/suno-callback`;

      const sunoPayload: any = {
        customMode: true,
        instrumental: true,
        model,
        style: cleanStyle,
        title: cleanTitle,
        callBackUrl: callbackUrl,
      };
      if (cleanNegTags) sunoPayload.negativeTags = cleanNegTags;

      const sunoRes = await fetch("https://api.sunoapi.org/api/v1/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${suno_api_key}`,
        },
        body: JSON.stringify(sunoPayload),
      });

      const sunoData = await sunoRes.json();

      if (!sunoRes.ok) {
        const sunoErrorMsg = sunoData?.message || sunoData?.error || sunoData?.detail
          || sunoData?.data?.message || sunoData?.data?.error
          || (typeof sunoData === "string" ? sunoData : "Unknown Suno error");
        console.warn(`Suno API rejected generation for @${agent.handle}: ${sunoRes.status} — ${sunoErrorMsg}`);
        return new Response(
          JSON.stringify({
            error: "Suno API rejected the generation request",
            suno_status: sunoRes.status,
            suno_error: sunoErrorMsg,
            tip: "Check your style tags for blocked keywords (artist names, explicit content). Adjust and retry.",
          }),
          { status: sunoRes.status, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      taskId = sunoData.data?.taskId || sunoData.taskId || null;
    }

    // ─── CREATE BEAT RECORDS ───────────────────────────────────────────
    const numBeats = useSelfHosted ? Math.max(selfHostedClipIds.length, 1) : 2;
    const beatRecords = [];
    for (let i = 0; i < numBeats; i++) {
      const beatInsert: Record<string, unknown> = {
        agent_id: agent.id,
        title: i === 0 ? cleanTitle : (cleanTitleV2 || `${cleanTitle} (v2)`),
        genre, sub_genre: finalSubGenre, style: cleanStyle, model, bpm: safeBpm,
        instrumental: true,
        negative_tags: cleanNegTags,
        task_id: taskId, status: "generating",
        price: safePrice,
        stems_price: safeStemsPrice,
        generation_source: useSelfHosted ? "selfhosted" : "sunoapi",
        ...(useSelfHosted && selfHostedClipIds[i] ? { suno_id: selfHostedClipIds[i] } : {}),
      };

      const { data: beat, error } = await supabase.from("beats")
        .insert(beatInsert).select().single();

      if (error) throw error;
      beatRecords.push(beat);
    }

    // beats_count is now managed by database trigger (trg_sync_agent_beats_count)
    // which fires when beat status changes to 'complete'. No manual increment needed.

    // ─── AUTO-CATALOG NEW GENRES ────────────────────────────────────
    // If the genre doesn't exist in the genres table yet, add it automatically
    const { data: existingGenre } = await supabase
      .from("genres").select("id").eq("id", genre).single();
    if (!existingGenre) {
      await supabase.from("genres").insert({
        id: genre,
        label: genre.charAt(0).toUpperCase() + genre.slice(1).replace(/-/g, " "),
        icon: "🎵",
        color: "#ff6b35",
      });
      console.log(`New genre auto-cataloged: ${genre}`);
    }

    // ─── STORE KEY TEMPORARILY FOR AUTO-WAV CONVERSION ──────────────
    // Only for sunoapi.org — self-hosted has no callbacks, agents use polling.
    if (!useSelfHosted && taskId && suno_api_key) {
      await supabase.from("pending_wav_keys").upsert({
        task_id: taskId,
        suno_api_key: suno_api_key,
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        task_id: taskId,
        generation_source: useSelfHosted ? "selfhosted" : "sunoapi",
        ...(useSelfHosted ? { used_centralized: useCentralized, g_credits_remaining: useCentralized ? (agent.g_credits || 0) - 1 : undefined } : {}),
        agent: { handle: agent.handle, music_soul: agentGenres.join(" × ") },
        beats: beatRecords.map((b) => ({ id: b.id, title: b.title, genre: b.genre, sub_genre: b.sub_genre, status: b.status, price: b.price, suno_id: b.suno_id || null })),
        message: useSelfHosted
          ? (useCentralized
            ? "Generating via MusiClaw's centralized Suno API (1 G-Credit used). Use poll-suno to check status."
            : "Generating via your self-hosted Suno instance (free). Use poll-suno to check status.")
          : "Generating. Suno callbacks in ~30-60s. WAV conversion is automatic. Your key was used once and NOT stored.",
      }),
      { status: 201, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Generate error:", err.message);
    return new Response(
      JSON.stringify({ error: "Beat generation failed. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
