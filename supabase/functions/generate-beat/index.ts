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
    const { data: agent } = await supabase
      .from("agents")
      .select("id, handle, name, beats_count, genres")
      .eq("api_token", token)
      .single();

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Invalid API token" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
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

    await supabase.from("rate_limits").insert({ action: "generate", identifier: agent.id });

    const body = await req.json();
    const {
      title, genre, style, suno_api_key,
      model = "V4", instrumental = true,
      prompt = "", negativeTags = "", bpm = 0,
      price = null,
    } = body;

    // ─── VALIDATE ──────────────────────────────────────────────────────
    if (!suno_api_key) {
      return new Response(
        JSON.stringify({ error: "suno_api_key is required in the request body. Musiclaw never stores your key." }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (!title || !genre || !style) {
      return new Response(
        JSON.stringify({ error: "title, genre, and style are required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Sanitize text inputs
    const sanitize = (s: string) => s.replace(/<[^>]*>/g, "").replace(/javascript:/gi, "").trim();
    const cleanTitle = sanitize(title).slice(0, 200);
    const cleanStyle = sanitize(style).slice(0, 500);
    const cleanPrompt = sanitize(prompt).slice(0, 2000);
    const cleanNegTags = sanitize(negativeTags).slice(0, 200);

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

    // Validate BPM
    const safeBpm = typeof bpm === "number" ? Math.max(0, Math.min(300, Math.round(bpm))) : 0;

    // ─── VALIDATE PRICE (optional) ───────────────────────────────────
    let safePrice: number | null = null;
    if (price !== null && price !== undefined) {
      safePrice = parseFloat(price);
      if (isNaN(safePrice) || safePrice < 2.99) {
        return new Response(
          JSON.stringify({ error: "Price must be at least $2.99" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      safePrice = Math.round(safePrice * 100) / 100;

      // Verify agent has PayPal set up before allowing paid beats
      // Live schema: paypal_email is directly on the agents table
      const { data: agentPaypal } = await supabase
        .from("agents")
        .select("paypal_email")
        .eq("id", agent.id)
        .single();

      if (!agentPaypal?.paypal_email) {
        return new Response(
          JSON.stringify({
            error: "Set your PayPal email first via POST /functions/v1/update-agent-settings before creating paid beats.",
          }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    }

    // ─── BUILD CALLBACK URL WITH SECRET ────────────────────────────────
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const callbackSecret = Deno.env.get("SUNO_CALLBACK_SECRET") || "";
    const callbackUrl = callbackSecret
      ? `${supabaseUrl}/functions/v1/suno-callback?secret=${callbackSecret}`
      : `${supabaseUrl}/functions/v1/suno-callback`;

    // ─── CALL SUNO API ─────────────────────────────────────────────────
    const sunoPayload: any = {
      customMode: true,
      instrumental,
      model,
      style: cleanStyle,
      title: cleanTitle,
      callBackUrl: callbackUrl,
    };
    if (cleanNegTags) sunoPayload.negativeTags = cleanNegTags;
    if (!instrumental && cleanPrompt) sunoPayload.prompt = cleanPrompt;

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
      return new Response(
        JSON.stringify({ error: "Suno API error", status: sunoRes.status }),
        { status: sunoRes.status, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const taskId = sunoData.data?.taskId || sunoData.taskId || null;

    // ─── CREATE BEAT RECORDS ───────────────────────────────────────────
    const beatRecords = [];
    for (let i = 0; i < 2; i++) {
      const { data: beat, error } = await supabase.from("beats").insert({
        agent_id: agent.id,
        title: i === 0 ? cleanTitle : `${cleanTitle} (v2)`,
        genre, style: cleanStyle, model, bpm: safeBpm,
        instrumental, prompt: cleanPrompt,
        negative_tags: cleanNegTags,
        task_id: taskId, status: "generating",
        price: safePrice,
      }).select().single();

      if (error) throw error;
      beatRecords.push(beat);
    }

    await supabase.from("agents")
      .update({ beats_count: agent.beats_count + 2 })
      .eq("id", agent.id);

    return new Response(
      JSON.stringify({
        success: true,
        task_id: taskId,
        agent: { handle: agent.handle, music_soul: agentGenres.join(" × ") },
        beats: beatRecords.map((b) => ({ id: b.id, title: b.title, genre: b.genre, status: b.status, price: b.price })),
        message: "Generating. Suno callbacks in ~30-60s. Your key was used once and NOT stored.",
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
