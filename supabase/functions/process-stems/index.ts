// supabase/functions/process-stems/index.ts
// POST /functions/v1/process-stems
// Headers: Authorization: Bearer <agent_api_token>
// Body: { beat_id }
// Triggers stem splitting (MVSEP via Railway) for Suno-generated beats.
// Uploaded beats (generation_source='upload') should include stems via upload-beat.
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
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

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
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const tokenBytes = new TextEncoder().encode(token);
    const hashBuffer = await crypto.subtle.digest("SHA-256", tokenBytes);
    const tokenHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

    let { data: agent } = await supabase.from("agents").select("id, handle, suno_self_hosted_url, g_credits, owner_email, mvsep_api_key").eq("api_token_hash", tokenHash).single();
    if (!agent) {
      const { data: fallback } = await supabase.from("agents").select("id, handle, suno_self_hosted_url, g_credits, owner_email, mvsep_api_key").eq("api_token", token).single();
      agent = fallback;
    }

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Invalid API token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: max 100 per hour per agent ───────────────────
    const { data: recentCalls } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "process_stems")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentCalls && recentCalls.length >= 100) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 100 process-stems calls per hour." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({
      action: "process_stems",
      identifier: agent.id,
    });

    // ─── VALIDATE INPUT ─────────────────────────────────────────────
    const body = await req.json();
    const { beat_id, stem_clip_ids: importClipIds } = body;

    if (!beat_id) {
      return new Response(
        JSON.stringify({ error: "beat_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP BEAT (must belong to this agent) ───────────────────
    const { data: beat } = await supabase
      .from("beats")
      .select("id, title, suno_id, task_id, status, agent_id, wav_status, stems_status, stems, generation_source, audio_url")
      .eq("id", beat_id)
      .eq("agent_id", agent.id)
      .single();

    if (!beat) {
      return new Response(
        JSON.stringify({ error: "Beat not found or does not belong to you" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (beat.status !== "complete") {
      return new Response(
        JSON.stringify({ error: "Beat is not yet complete. Wait for generation to finish, then call this endpoint." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── VALIDATE BEAT FOR STEM PROCESSING ─────────────────────────────
    const generationSource = beat.generation_source || "selfhosted";

    // Uploaded beats don't support Suno stem splitting — stems should be uploaded directly
    if (generationSource === "upload") {
      return new Response(
        JSON.stringify({
          error: "Uploaded beats don't support Suno stem splitting. To add stems, use the upload-beat endpoint with a 'stems' object containing URLs for each stem (drums, bass, vocals, melody, other).",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!beat.suno_id) {
      return new Response(
        JSON.stringify({ error: "Beat has no Suno ID — cannot process stems." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // If both are stuck in processing, allow retry (callbacks may have failed)
    if (beat.wav_status === "processing" && beat.stems_status === "processing") {
      console.log(`Re-triggering WAV/stems for beat ${beat.id} (both were stuck in processing state)`);
    }

    if (beat.wav_status === "complete" && beat.stems_status === "complete") {
      return new Response(
        JSON.stringify({
          message: "WAV and stems are already complete for this beat.",
          wav_status: beat.wav_status,
          stems_status: beat.stems_status,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // If either is "failed", allow retry
    console.log(`Process-stems for beat ${beat.id}: wav_status=${beat.wav_status}, stems_status=${beat.stems_status} — proceeding`);

    // ─── TRIGGER STEMS ─────────────────────────────────────────────
    const results: string[] = [];

    // ─── WAV HANDLING ──────────────────────────────────────────────
    // Self-hosted audio is direct MP3 — WAV is always "complete"
    if (beat.wav_status !== "complete") {
      await supabase.from("beats").update({ wav_status: "complete" }).eq("id", beat.id);
      results.push("WAV: audio is direct — marked complete");
    } else {
      results.push("WAV already complete");
    }

    // ─── STEMS: Dispatch to Railway stem-processor service ────────
    if (beat.stems_status !== "complete") {
      const mvsepKey = agent.mvsep_api_key || null;
      if (!mvsepKey) {
        return new Response(
          JSON.stringify({
            error: "MVSEP API key required for stem splitting. Set yours via POST /functions/v1/update-agent-settings with { mvsep_api_key: \"your-key\" }. Get one at mvsep.com/user-api",
            beat_id: beat.id,
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Dispatch to Railway stem-processor (fire-and-forget)
      const stemProcessorUrl = Deno.env.get("STEM_PROCESSOR_URL");
      const railwaySecret = Deno.env.get("RAILWAY_SERVICE_SECRET");

      if (!stemProcessorUrl || !railwaySecret) {
        console.error("STEM_PROCESSOR_URL or RAILWAY_SERVICE_SECRET not configured");
        return new Response(
          JSON.stringify({ error: "Stem processor not configured" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const audioUrl = beat.audio_url || `https://cdn1.suno.ai/${beat.suno_id}.mp3`;

      try {
        const railwayRes = await fetch(`${stemProcessorUrl}/process-stems`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-service-secret": railwaySecret,
          },
          body: JSON.stringify({
            beat_id: beat.id,
            agent_id: agent.id,
            mvsep_api_key: mvsepKey,
            audio_url: audioUrl,
            suno_id: beat.suno_id,
          }),
        });

        if (railwayRes.ok) {
          await supabase.from("beats").update({ stems_status: "processing" }).eq("id", beat.id);
          results.push("Stem splitting dispatched (MVSEP BS Roformer SW). Will complete automatically in ~2-5 minutes.");
          console.log(`Beat ${beat.id} dispatched to stem-processor`);
        } else {
          const errBody = await railwayRes.text();
          console.error(`Railway error: ${railwayRes.status} ${errBody.slice(0, 200)}`);
          results.push("Stem splitting dispatch failed. Please try again.");
        }
      } catch (fetchErr) {
        console.error("Railway fetch error:", (fetchErr as Error).message);
        results.push("Stem splitting dispatch failed: network error");
      }
    } else {
      results.push("Stems already complete");
    }

    return new Response(
      JSON.stringify({
        success: true,
        beat_id: beat.id,
        beat_title: beat.title,
        generation_source: generationSource,
        results,
        message: "Stem splitting dispatched to processor (MVSEP BS Roformer SW). Completes automatically in ~2-5 minutes.",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Process stems error:", err.message);
    return new Response(
      JSON.stringify({ error: "Failed to process stems. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
