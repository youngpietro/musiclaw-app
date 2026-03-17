// supabase/functions/process-stems/index.ts
// POST /functions/v1/process-stems
// Headers: Authorization: Bearer <agent_api_token>
// Body: { beat_id }
// Triggers stem splitting via sunoapi.org (if agent uses sunoapi provider) or MVSEP on Railway.
// SECURITY: Bearer auth, rate limiting, beat ownership validation

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAgent } from "../_shared/auth.ts";
import { decrypt } from "../_shared/crypto.ts";

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
    const { agent, error: authError } = await verifyAgent(req, supabase, "id, handle, suno_api_provider, suno_api_key, g_credits, owner_email, mvsep_api_key", corsHeaders);
    if (authError) return authError;
    if (agent.suno_api_key) agent.suno_api_key = await decrypt(agent.suno_api_key as string);
    if (agent.mvsep_api_key) agent.mvsep_api_key = await decrypt(agent.mvsep_api_key as string);

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
    const { beat_id } = body;

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

    // Uploaded beats don't support stem splitting — stems should be uploaded directly
    if (generationSource === "upload") {
      return new Response(
        JSON.stringify({
          error: "Uploaded beats don't support stem splitting. To add stems, use the upload-beat endpoint with a 'stems' object containing URLs for each stem (drums, bass, vocals, melody, other).",
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
    // Audio is direct MP3 — WAV is always "complete"
    if (beat.wav_status !== "complete") {
      await supabase.from("beats").update({ wav_status: "complete" }).eq("id", beat.id);
      results.push("WAV: audio is direct — marked complete");
    } else {
      results.push("WAV already complete");
    }

    // ─── STEMS: Decision tree based on provider config ─────────────
    if (beat.stems_status !== "complete") {
      const useSunoapi = agent.suno_api_provider === "sunoapi" && agent.suno_api_key;
      const useMvsep = !!agent.mvsep_api_key;

      if (useSunoapi) {
        // ─── sunoapi.org stem splitting via shared provider module ───
        try {
          const { splitStems } = await import("../_shared/suno-providers.ts");
          const stemsCallbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/suno-callback?secret=${Deno.env.get("SUNO_CALLBACK_SECRET")}&type=stems&beat_id=${beat.id}`;
          await splitStems(agent.suno_api_key, beat.task_id, beat.suno_id, stemsCallbackUrl);

          await supabase.from("beats").update({ stems_status: "processing" }).eq("id", beat.id);
          results.push("Stem splitting dispatched via sunoapi.org. Will complete automatically via callback.");
          console.log(`Beat ${beat.id} dispatched to sunoapi.org for stem splitting`);
        } catch (stemErr) {
          const errMsg = (stemErr as Error).message;
          console.error(`sunoapi stems error for beat ${beat.id}:`, errMsg);
          if (errMsg === "API_KEY_INVALID") {
            return new Response(
              JSON.stringify({ error: "sunoapi.org API key is invalid. Update it via POST /functions/v1/update-agent-settings." }),
              { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          if (errMsg === "INSUFFICIENT_CREDITS") {
            return new Response(
              JSON.stringify({ error: "Insufficient credits on sunoapi.org for stem splitting. Top up your account." }),
              { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          results.push(`Stem splitting via sunoapi.org failed: ${errMsg}`);
        }
      } else if (useMvsep) {
        // ─── MVSEP via Railway stem-processor (existing path) ────────
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
              mvsep_api_key: agent.mvsep_api_key,
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
        // ─── No stem splitting method available ──────────────────────
        return new Response(
          JSON.stringify({
            error: "No stem splitting method configured. Either set suno_api_provider to 'sunoapi' with a suno_api_key, or set an mvsep_api_key via POST /functions/v1/update-agent-settings.",
            beat_id: beat.id,
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    } else {
      results.push("Stems already complete");
    }

    const stemMethod = agent.suno_api_provider === "sunoapi" && agent.suno_api_key
      ? "sunoapi.org vocal-removal"
      : "MVSEP BS Roformer SW";

    return new Response(
      JSON.stringify({
        success: true,
        beat_id: beat.id,
        beat_title: beat.title,
        generation_source: generationSource,
        stem_method: stemMethod,
        results,
        message: `Stem splitting dispatched (${stemMethod}). Completes automatically via callback.`,
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
