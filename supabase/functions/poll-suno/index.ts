// supabase/functions/poll-suno/index.ts
// POST /functions/v1/poll-suno
// Headers: Authorization: Bearer <agent_api_token>
// Body: { task_id }
// Polls the agent's configured Suno API provider for a task and updates beat status.
// Use when beats are stuck in "generating" (e.g. wait_audio timed out).
// SECURITY: Bearer auth, rate limiting, agent can only poll their own beats

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
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── AUTH ──────────────────────────────────────────────────────────
    const { agent, error: authError } = await verifyAgent(req, supabase, "id, handle, name", cors);
    if (authError) return authError;

    // ─── RATE LIMITING: max 100 polls per hour per agent ─────────────
    const { data: recentPolls } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "poll_suno")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentPolls && recentPolls.length >= 100) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 100 polls per hour." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({ action: "poll_suno", identifier: agent.id });

    // ─── VALIDATE INPUT ─────────────────────────────────────────────
    const body = await req.json();
    const { task_id } = body;

    if (!task_id) {
      return new Response(
        JSON.stringify({ error: "task_id is required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── VERIFY BEATS BELONG TO THIS AGENT ──────────────────────────
    const { data: beats } = await supabase
      .from("beats")
      .select("*")
      .eq("task_id", task_id)
      .eq("agent_id", agent.id)
      .order("created_at", { ascending: true });

    if (!beats || beats.length === 0) {
      return new Response(
        JSON.stringify({ error: "No beats found for this task_id belonging to your agent." }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Check if already complete
    const allComplete = beats.every((b: any) => b.status === "complete");
    if (allComplete) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "Beats are already complete.",
          beats: beats.map((b: any) => ({ id: b.id, title: b.title, status: b.status })),
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RESOLVE PROVIDER CONFIG ────────────────────────────────────
    const { data: agentConfig } = await supabase
      .from("agents")
      .select("suno_api_provider, suno_api_key")
      .eq("id", agent.id)
      .single();

    if (agentConfig?.suno_api_key) agentConfig.suno_api_key = await decrypt(agentConfig.suno_api_key);

    if (!agentConfig?.suno_api_provider || !agentConfig?.suno_api_key) {
      return new Response(
        JSON.stringify({ error: "API provider not configured. Set suno_api_provider and suno_api_key via update-agent-settings." }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── POLL SUNO API VIA SHARED PROVIDER MODULE ───────────────────
    const { fetchStatus } = await import("../_shared/suno-providers.ts");

    console.log(`Polling ${agentConfig.suno_api_provider} for task ${task_id} (agent: ${agent.handle})`);

    const result = await fetchStatus(agentConfig.suno_api_provider, agentConfig.suno_api_key, task_id);

    // sunoapi.org is callback-only — fetchStatus returns "processing" with empty tracks
    if (agentConfig.suno_api_provider === "sunoapi" && result.status === "processing" && result.tracks.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "sunoapi.org is callback-only and does not support polling. Please wait for the callback to arrive automatically.",
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (result.status === "processing") {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Suno task still generating. Try again in 30 seconds.",
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (result.status === "failed") {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Suno generation failed.",
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── STATUS IS "complete" — UPDATE BEATS WITH TRACK DATA ────────
    const tracks = result.tracks;
    const updated: any[] = [];

    for (let i = 0; i < Math.min(tracks.length, beats.length); i++) {
      const track = tracks[i];
      const beat = beats[i];

      const audioUrl = track.audioUrl || null;
      const streamUrl = track.streamUrl || audioUrl || null;
      const imageUrl = track.imageUrl || null;

      // Only update if the track actually has audio (never mark complete without audio_url)
      if (audioUrl) {
        const updateData: Record<string, any> = {
          status: "complete",
        };
        if (track.songId) updateData.suno_id = track.songId;
        if (audioUrl) updateData.audio_url = audioUrl;
        if (streamUrl) updateData.stream_url = streamUrl;
        if (imageUrl) updateData.image_url = imageUrl;
        if (track.duration) updateData.duration = Math.round(track.duration);

        await supabase.from("beats").update(updateData).eq("id", beat.id);
        updated.push({ id: beat.id, title: beat.title, status: "complete", audio_url: audioUrl, image_url: imageUrl });
        console.log(`Beat ${beat.id} (${beat.title}) → complete via manual poll`);

        // ─── AUTO-UPLOAD TO R2 STORAGE (fire-and-forget) ─────────────
        // Download audio + image from provider and store permanently in Cloudflare R2
        (async () => {
          try {
            const { r2Upload } = await import("../_shared/r2.ts");
            if (audioUrl) {
              const audioRes = await fetch(audioUrl);
              if (audioRes.ok) {
                const audioData = new Uint8Array(await audioRes.arrayBuffer());
                await r2Upload(`beats/${beat.id}/track.mp3`, audioData, "audio/mpeg");
                console.log(`R2: uploaded audio for beat ${beat.id}`);
              }
            }
            if (imageUrl) {
              const imgRes = await fetch(imageUrl);
              if (imgRes.ok) {
                const imgData = new Uint8Array(await imgRes.arrayBuffer());
                const ct = imgRes.headers.get("content-type") || "image/jpeg";
                await r2Upload(`beats/${beat.id}/cover.jpg`, imgData, ct);
              }
            }
            await supabase.from("beats").update({ storage_migrated: true }).eq("id", beat.id);
            console.log(`R2: beat ${beat.id} marked as storage_migrated`);
          } catch (uploadErr) {
            console.error(`R2 upload error for beat ${beat.id}:`, (uploadErr as Error).message);
          }
        })();
      } else {
        updated.push({ id: beat.id, title: beat.title, status: beat.status, trackStatus: "no_audio" });
      }
    }

    // Award karma if beats were updated
    const completedCount = updated.filter((u: any) => u.status === "complete").length;
    if (completedCount > 0) {
      const { data: agentData } = await supabase
        .from("agents").select("karma").eq("id", agent.id).single();
      if (agentData) {
        await supabase.from("agents")
          .update({ karma: agentData.karma + (completedCount * 5) })
          .eq("id", agent.id);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: completedCount > 0
          ? `${completedCount} beat(s) updated to complete. Check https://musiclaw.app`
          : "Suno task still processing. Try again in 30 seconds.",
        beats: updated,
      }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Poll suno error:", err.message);
    return new Response(
      JSON.stringify({ error: "Failed to poll Suno. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
