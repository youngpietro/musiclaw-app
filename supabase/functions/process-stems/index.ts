// supabase/functions/process-stems/index.ts
// POST /functions/v1/process-stems
// Headers: Authorization: Bearer <agent_api_token>
// Body: { beat_id, suno_api_key?, suno_cookie? }
// Triggers WAV conversion + stem splitting for Suno-generated beats.
// Supports sunoapi.org (suno_api_key) and self-hosted (suno_cookie).
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
    const { beat_id, suno_api_key, suno_cookie: inlineCookie, stem_clip_ids: importClipIds } = body;

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

    // ─── DETERMINE GENERATION SOURCE ──────────────────────────────────
    const generationSource = beat.generation_source || "sunoapi";
    const useSelfHosted = generationSource === "selfhosted";

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
        JSON.stringify({ error: "Beat has no Suno ID — cannot process WAV/stems." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // sunoapi.org beats need task_id ONLY when using sunoapi.org path (not MVSEP)
    if (!useSelfHosted && !beat.task_id && !agent.mvsep_api_key) {
      return new Response(
        JSON.stringify({ error: "Beat has no generation task_id — cannot process WAV/stems via sunoapi.org." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── RESOLVE CREDENTIALS ─────────────────────────────────────────
    let effectiveCookie = inlineCookie || null;
    if (useSelfHosted && !effectiveCookie) {
      const { data: agentFull } = await supabase
        .from("agents").select("suno_cookie").eq("id", agent.id).single();
      effectiveCookie = agentFull?.suno_cookie || null;
    }
    // Fallback to centralized cookie env var (for G-Credit agents without their own cookie)
    if (useSelfHosted && !effectiveCookie) {
      effectiveCookie = Deno.env.get("SUNO_SELF_HOSTED_COOKIE") || null;
    }

    if (useSelfHosted && !effectiveCookie) {
      return new Response(
        JSON.stringify({ error: "suno_cookie is required for self-hosted beats. Pass it in the request or store it via update-agent-settings." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // suno_api_key is only required for sunoapi.org beats WITHOUT an MVSEP key
    // (MVSEP handles stems directly, sunoapi.org key only needed for WAV + old split_stem path)
    if (!useSelfHosted && !suno_api_key && !agent.mvsep_api_key) {
      return new Response(
        JSON.stringify({ error: "suno_api_key or mvsep_api_key is required. Set your MVSEP key via update-agent-settings, or pass suno_api_key for sunoapi.org." }),
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

    // ─── TRIGGER WAV + STEMS ────────────────────────────────────────
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const callbackSecret = Deno.env.get("SUNO_CALLBACK_SECRET");
    const selfHostedUrl = useSelfHosted
      ? (agent.suno_self_hosted_url || Deno.env.get("SUNO_SELF_HOSTED_URL"))
      : null;
    const useCentralized = useSelfHosted && !agent.suno_self_hosted_url && !!Deno.env.get("SUNO_SELF_HOSTED_URL");
    // callbackSecret only needed for sunoapi.org path (not MVSEP)
    if (!useSelfHosted && !callbackSecret && !agent.mvsep_api_key) {
      console.error("SUNO_CALLBACK_SECRET not configured");
      return new Response(
        JSON.stringify({ error: "Server misconfigured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (useSelfHosted && !selfHostedUrl) {
      return new Response(
        JSON.stringify({ error: "No self-hosted Suno API URL configured. Set yours via update-agent-settings." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: string[] = [];

    // ─── G-CREDIT DEDUCTION ────────────────────────────────────────────
    // Stems now use MVSEP (agent pays directly) → no G-Credit for stems.
    // G-Credits are only charged for sunoapi.org stems if we re-enable that path.
    let gcreditDeducted = false;
    const shouldChargeGCredit = false; // MVSEP stems = agent-paid, no platform cost
    if (shouldChargeGCredit) {
      const creditOwnerEmail = agent.owner_email?.trim().toLowerCase();
      if (!creditOwnerEmail) {
        return new Response(
          JSON.stringify({ error: "Agent has no owner_email set. Register with an email first." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const { data: newBal, error: gcErr } = await supabase.rpc("deduct_owner_gcredits", {
        p_email: creditOwnerEmail, p_amount: 1,
      });
      if (gcErr) {
        // Get current balance for error message
        const { data: ownerCr } = await supabase.from("owner_gcredits").select("g_credits").eq("owner_email", creditOwnerEmail).single();
        return new Response(
          JSON.stringify({
            error: "Insufficient G-Credits. You need 1 G-Credit for stems on the centralized Suno API.",
            g_credits: ownerCr?.g_credits ?? 0,
            owner_email: creditOwnerEmail,
            buy: "POST /functions/v1/manage-gcredits with {\"action\":\"buy\"} — $5 = 50 G-Credits",
          }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      gcreditDeducted = true;
      await supabase.from("gcredit_usage").insert({
        agent_id: agent.id, action: "stems", credits_spent: 1, beat_id: beat.id,
      });
      console.log(`G-Credit deducted: 1 from owner ${creditOwnerEmail} via @${agent.handle} for stems (balance: ${newBal})`);
    }

    // ─── MVSEP vs SUNOAPI.ORG ROUTING ──────────────────────────────
    // If agent has a MVSEP key → use MVSEP for stems (any beat).
    // Otherwise, sunoapi.org beats fall back to sunoapi.org split_stem.
    const mvsepKey = agent.mvsep_api_key || null;
    const useMvsep = !!mvsepKey;

    if (useSelfHosted || useMvsep) {
      // ─── WAV HANDLING ──────────────────────────────────────────────
      if (useSelfHosted && beat.wav_status !== "complete") {
        await supabase.from("beats").update({ wav_status: "complete" }).eq("id", beat.id);
        results.push("WAV: self-hosted audio is direct — marked complete");
      } else if (!useSelfHosted && beat.wav_status !== "complete" && beat.wav_status !== "processing") {
        if (suno_api_key && callbackSecret) {
          try {
            const wavRes = await fetch("https://api.sunoapi.org/api/v1/wav/generate", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${suno_api_key}` },
              body: JSON.stringify({
                taskId: beat.task_id, audioId: beat.suno_id,
                callBackUrl: `${supabaseUrl}/functions/v1/wav-callback?secret=${callbackSecret}&beat_id=${beat.id}`,
              }),
            });
            if (wavRes.ok) {
              await supabase.from("beats").update({ wav_status: "processing" }).eq("id", beat.id);
              results.push("WAV conversion triggered via sunoapi.org");
            } else {
              results.push("WAV conversion skipped (sunoapi.org error)");
            }
          } catch { results.push("WAV conversion skipped (network error)"); }
        } else {
          results.push("WAV: skipped (no suno_api_key for sunoapi.org WAV)");
        }
      } else {
        results.push("WAV already complete");
      }

      // ─── STEMS: Dispatch to Railway stem-processor service ────────
      if (beat.stems_status !== "complete") {
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

    } else {
      // ─── SUNOAPI.ORG: WAV + STEMS (existing logic) ────────────────

      // 1. WAV conversion — auto-triggered by suno-callback, manual retry here as fallback
      if (beat.wav_status === "failed" || (beat.wav_status !== "complete" && beat.wav_status !== "processing")) {
        try {
          const wavRes = await fetch("https://api.sunoapi.org/api/v1/wav/generate", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${suno_api_key}`,
            },
            body: JSON.stringify({
              taskId: beat.task_id,
              audioId: beat.suno_id,
              callBackUrl: `${supabaseUrl}/functions/v1/wav-callback?secret=${callbackSecret}&beat_id=${beat.id}`,
            }),
          });

          const wavBody = await wavRes.text();
          console.log(`WAV retry for beat ${beat.id}: status=${wavRes.status} body=${wavBody.slice(0, 500)}`);

          let wavApiError = false;
          try {
            const wavJson = JSON.parse(wavBody);
            if (wavJson.code && wavJson.code >= 400) wavApiError = true;
            if (wavJson.error || wavJson.message?.toLowerCase().includes("error")) wavApiError = true;
          } catch { /* not JSON */ }

          if (wavRes.ok && !wavApiError) {
            await supabase.from("beats").update({ wav_status: "processing" }).eq("id", beat.id);
            results.push("WAV conversion re-triggered (was failed/missing)");
          } else {
            await supabase.from("beats").update({ wav_status: "failed" }).eq("id", beat.id);
            results.push("WAV conversion retry failed: " + (wavRes.status === 401 ? "Invalid API key" : `API error (${wavRes.status})`));
          }
        } catch (wavErr) {
          console.error(`WAV retry failed for beat ${beat.id}:`, wavErr.message);
          await supabase.from("beats").update({ wav_status: "failed" }).eq("id", beat.id);
          results.push("WAV conversion retry failed: network error");
        }
      } else if (beat.wav_status === "processing") {
        results.push("WAV conversion in progress (auto-triggered)");
      } else {
        results.push("WAV already complete");
      }

      // 2. Trigger stem splitting (if not already complete)
      if (beat.stems_status !== "complete") {
        try {
          const stemsRes = await fetch("https://api.sunoapi.org/api/v1/vocal-removal/generate", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${suno_api_key}`,
            },
            body: JSON.stringify({
              taskId: beat.task_id,
              audioId: beat.suno_id,
              type: "split_stem",
              callBackUrl: `${supabaseUrl}/functions/v1/stems-callback?secret=${callbackSecret}&beat_id=${beat.id}`,
            }),
          });

          const stemsBody = await stemsRes.text();
          console.log(`Stems API response for beat ${beat.id}: status=${stemsRes.status} body=${stemsBody.slice(0, 500)}`);

          let stemsApiError = false;
          try {
            const stemsJson = JSON.parse(stemsBody);
            if (stemsJson.code && stemsJson.code >= 400) stemsApiError = true;
            if (stemsJson.error || stemsJson.message?.toLowerCase().includes("error")) stemsApiError = true;
          } catch { /* not JSON, check status only */ }

          if (stemsRes.ok && !stemsApiError) {
            await supabase.from("beats").update({ stems_status: "processing" }).eq("id", beat.id);
            results.push("Stem splitting triggered (50 credits)");
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
    }

    return new Response(
      JSON.stringify({
        success: true,
        beat_id: beat.id,
        beat_title: beat.title,
        generation_source: generationSource,
        ...(gcreditDeducted ? { gcredit_spent: 1 } : {}),
        results,
        message: useMvsep
          ? "Stem splitting dispatched to processor (MVSEP BS Roformer SW). Completes automatically in ~2-5 minutes."
          : "Stem splitting via sunoapi.org (split_stem). Callback updates the beat. Your key was used and NOT stored.",
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
