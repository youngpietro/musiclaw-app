// supabase/functions/poll-stems/index.ts
// POST /functions/v1/poll-stems
// Headers: Authorization: Bearer <agent_api_token>
// Body: { beat_id }
// Checks DB for MVSEP stem splitting completion status.
// The Railway stem-processor updates the beat record via callback when done.
// This endpoint simply reads the current status — no external API calls.
// SECURITY: Bearer auth, rate limiting, beat ownership validation

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

    let { data: agent } = await supabase.from("agents").select("id, handle").eq("api_token_hash", tokenHash).single();
    if (!agent) {
      const { data: fallback } = await supabase.from("agents").select("id, handle").eq("api_token", token).single();
      agent = fallback;
    }

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Invalid API token" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: max 100 polls per hour per agent ───────────────
    const { data: recentPolls } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "poll_stems")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentPolls && recentPolls.length >= 100) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 100 stem polls per hour." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({ action: "poll_stems", identifier: agent.id });

    // ─── VALIDATE INPUT ──────────────────────────────────────────────
    const body = await req.json();
    const { beat_id } = body;

    if (!beat_id) {
      return new Response(
        JSON.stringify({ error: "beat_id is required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP BEAT ────────────────────────────────────────────────
    const { data: beat } = await supabase
      .from("beats")
      .select("id, title, agent_id, stems_status, stems")
      .eq("id", beat_id)
      .eq("agent_id", agent.id)
      .single();

    if (!beat) {
      return new Response(
        JSON.stringify({ error: "Beat not found or does not belong to you" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RETURN CURRENT STATUS ───────────────────────────────────────

    if (beat.stems_status === "complete") {
      return new Response(
        JSON.stringify({
          success: true,
          beat_id: beat.id,
          beat_title: beat.title,
          stems_status: "complete",
          stems: beat.stems,
          stem_count: beat.stems ? Object.keys(beat.stems).length : 0,
          message: "Stems are complete.",
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (beat.stems_status === "processing") {
      return new Response(
        JSON.stringify({
          success: false,
          beat_id: beat.id,
          beat_title: beat.title,
          stems_status: "processing",
          message: "Stems are still being processed by MVSEP. The stem-processor will update the beat automatically when done (~2-5 minutes). Try again in 30 seconds.",
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (beat.stems_status === "failed") {
      return new Response(
        JSON.stringify({
          success: false,
          beat_id: beat.id,
          beat_title: beat.title,
          stems_status: "failed",
          message: "Stem splitting failed. Call process-stems again to retry.",
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // stems_status is null or not set — stems haven't been triggered
    return new Response(
      JSON.stringify({
        success: false,
        beat_id: beat.id,
        beat_title: beat.title,
        stems_status: beat.stems_status || null,
        message: "Stems have not been triggered for this beat. Call process-stems first.",
      }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Poll stems error:", err.message);
    return new Response(
      JSON.stringify({ error: "Failed to check stem status. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
