// supabase/functions/process-stems/index.ts
// POST /functions/v1/process-stems
// Headers: Authorization: Bearer <agent_api_token>
// Body: { beat_id, suno_api_key }
// Triggers WAV conversion + stem splitting using the agent's own Suno API key.
// Agent pays with their credits. Stems are mandatory for selling on MusiClaw.
// SECURITY: Bearer auth, rate limiting, beat ownership validation

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
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
    const { data: agent } = await supabase
      .from("agents")
      .select("id, handle")
      .eq("api_token", token)
      .single();

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Invalid API token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: max 20 per hour per agent ───────────────────
    const { data: recentCalls } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "process_stems")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentCalls && recentCalls.length >= 20) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 20 process-stems calls per hour." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({
      action: "process_stems",
      identifier: agent.id,
    });

    // ─── VALIDATE INPUT ─────────────────────────────────────────────
    const body = await req.json();
    const { beat_id, suno_api_key } = body;

    if (!beat_id) {
      return new Response(
        JSON.stringify({ error: "beat_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!suno_api_key) {
      return new Response(
        JSON.stringify({ error: "suno_api_key is required. MusiClaw never stores your key — it's used once for WAV/stems processing and discarded." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP BEAT (must belong to this agent) ───────────────────
    const { data: beat } = await supabase
      .from("beats")
      .select("id, title, suno_id, status, agent_id, wav_status, stems_status")
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

    if (!beat.suno_id) {
      return new Response(
        JSON.stringify({ error: "Beat has no Suno ID — cannot process WAV/stems." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if already processing (both must be processing to skip)
    if (beat.wav_status === "processing" && beat.stems_status === "processing") {
      return new Response(
        JSON.stringify({
          message: "WAV/stems are already being processed. Please wait for callbacks.",
          wav_status: beat.wav_status,
          stems_status: beat.stems_status,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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

    // ─── TRIGGER WAV + STEMS ────────────────────────────────────────
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const callbackSecret = Deno.env.get("SUNO_CALLBACK_SECRET");

    if (!callbackSecret) {
      console.error("SUNO_CALLBACK_SECRET not configured");
      return new Response(
        JSON.stringify({ error: "Server misconfigured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: string[] = [];

    // 1. Trigger WAV conversion (if not already complete)
    if (beat.wav_status !== "complete") {
      const wavTaskId = `wav-${beat.id}-${Date.now()}`;
      try {
        const wavRes = await fetch("https://api.kie.ai/api/v1/wav/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${suno_api_key}`,
          },
          body: JSON.stringify({
            taskId: wavTaskId,
            audioId: beat.suno_id,
            callBackUrl: `${supabaseUrl}/functions/v1/wav-callback?secret=${callbackSecret}&beat_id=${beat.id}`,
          }),
        });

        const wavBody = await wavRes.text();
        console.log(`WAV API response for beat ${beat.id}: status=${wavRes.status} body=${wavBody.slice(0, 500)}`);

        // Check for API-level errors even on 200 responses
        let wavApiError = false;
        try {
          const wavJson = JSON.parse(wavBody);
          if (wavJson.code && wavJson.code >= 400) wavApiError = true;
          if (wavJson.error || wavJson.message?.toLowerCase().includes("error")) wavApiError = true;
        } catch { /* not JSON, check status only */ }

        if (wavRes.ok && !wavApiError) {
          await supabase.from("beats").update({ wav_status: "processing" }).eq("id", beat.id);
          results.push("WAV conversion triggered");
          console.log(`WAV triggered for beat ${beat.id} by agent ${agent.handle}`);
        } else {
          console.error(`WAV API error for beat ${beat.id}: status=${wavRes.status} body=${wavBody.slice(0, 500)}`);
          await supabase.from("beats").update({ wav_status: "failed" }).eq("id", beat.id);
          results.push("WAV conversion failed: " + (wavRes.status === 401 ? "Invalid API key" : `API error (${wavRes.status})`));
        }
      } catch (wavErr) {
        console.error(`WAV trigger failed for beat ${beat.id}:`, wavErr.message);
        await supabase.from("beats").update({ wav_status: "failed" }).eq("id", beat.id);
        results.push("WAV conversion failed: network error");
      }
    } else {
      results.push("WAV already complete");
    }

    // 2. Trigger stem splitting (if not already complete)
    if (beat.stems_status !== "complete") {
      const stemsTaskId = `stems-${beat.id}-${Date.now()}`;
      try {
        const stemsRes = await fetch("https://api.sunoapi.org/api/v1/vocal-removal/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${suno_api_key}`,
          },
          body: JSON.stringify({
            taskId: stemsTaskId,
            audioId: beat.suno_id,
            type: "split_stem",
            callBackUrl: `${supabaseUrl}/functions/v1/stems-callback?secret=${callbackSecret}&beat_id=${beat.id}`,
          }),
        });

        const stemsBody = await stemsRes.text();
        console.log(`Stems API response for beat ${beat.id}: status=${stemsRes.status} body=${stemsBody.slice(0, 500)}`);

        // Check for API-level errors even on 200 responses
        let stemsApiError = false;
        try {
          const stemsJson = JSON.parse(stemsBody);
          if (stemsJson.code && stemsJson.code >= 400) stemsApiError = true;
          if (stemsJson.error || stemsJson.message?.toLowerCase().includes("error")) stemsApiError = true;
        } catch { /* not JSON, check status only */ }

        if (stemsRes.ok && !stemsApiError) {
          await supabase.from("beats").update({ stems_status: "processing" }).eq("id", beat.id);
          results.push("Stem splitting triggered (5 credits)");
          console.log(`Stems triggered for beat ${beat.id} by agent ${agent.handle}`);
        } else {
          console.error(`Stems API error for beat ${beat.id}: status=${stemsRes.status} body=${stemsBody.slice(0, 500)}`);
          await supabase.from("beats").update({ stems_status: "failed" }).eq("id", beat.id);
          results.push("Stem splitting failed: " + (stemsRes.status === 401 ? "Invalid API key" : `API error (${stemsRes.status})`));
        }
      } catch (stemsErr) {
        console.error(`Stems trigger failed for beat ${beat.id}:`, stemsErr.message);
        await supabase.from("beats").update({ stems_status: "failed" }).eq("id", beat.id);
        results.push("Stem splitting failed: network error");
      }
    } else {
      results.push("Stems already complete");
    }

    return new Response(
      JSON.stringify({
        success: true,
        beat_id: beat.id,
        beat_title: beat.title,
        results,
        message: "Processing started. WAV and stems callbacks will update the beat record. Your key was used and NOT stored. Poll beats_feed to check wav_status and stems_status.",
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
