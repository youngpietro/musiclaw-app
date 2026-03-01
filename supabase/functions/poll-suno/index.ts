// supabase/functions/poll-suno/index.ts
// POST /functions/v1/poll-suno
// Headers: Authorization: Bearer <agent_api_token>
// Body: { task_id, suno_api_key }
// Manually polls Suno API for a task and updates beat status.
// Use when the callback didn't fire and beats are stuck in "generating".
// SECURITY: Bearer auth, rate limiting, agent can only poll their own beats

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

    let { data: agent } = await supabase.from("agents").select("id, handle, name").eq("api_token_hash", tokenHash).single();
    if (!agent) {
      const { data: fallback } = await supabase.from("agents").select("id, handle, name").eq("api_token", token).single();
      agent = fallback;
    }

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Invalid API token" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: max 10 polls per hour per agent ─────────────
    const { data: recentPolls } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "poll_suno")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentPolls && recentPolls.length >= 10) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 10 polls per hour." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({ action: "poll_suno", identifier: agent.id });

    // ─── VALIDATE INPUT ─────────────────────────────────────────────
    const body = await req.json();
    const { task_id, suno_api_key } = body;

    if (!task_id || !suno_api_key) {
      return new Response(
        JSON.stringify({ error: "task_id and suno_api_key are required" }),
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

    // ─── POLL SUNO API ──────────────────────────────────────────────
    console.log(`Polling Suno API for task ${task_id} (agent: ${agent.handle})`);

    const sunoRes = await fetch(`https://api.sunoapi.org/api/v1/generate/record?taskId=${task_id}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${suno_api_key}`,
      },
    });

    if (!sunoRes.ok) {
      const errText = await sunoRes.text();
      console.error(`Suno API poll failed: ${sunoRes.status} — ${errText}`);
      return new Response(
        JSON.stringify({ error: `Suno API returned ${sunoRes.status}. Check your API key.` }),
        { status: sunoRes.status, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const sunoData = await sunoRes.json();
    console.log("Suno poll response:", JSON.stringify(sunoData).slice(0, 1000));

    // ─── EXTRACT TRACKS FROM SUNO RESPONSE ──────────────────────────
    // Suno record API response formats:
    //   { data: [{ id, audio_url, stream_url, image_url, duration, status }] }
    //   { data: { data: [tracks], status } }
    //   { response: { data: [tracks] } }

    let tracks: any[] = [];

    if (sunoData.data) {
      if (Array.isArray(sunoData.data)) {
        tracks = sunoData.data;
      } else if (sunoData.data.data && Array.isArray(sunoData.data.data)) {
        tracks = sunoData.data.data;
      } else if (sunoData.data.response && Array.isArray(sunoData.data.response)) {
        tracks = sunoData.data.response;
      }
    }
    if (tracks.length === 0 && sunoData.response && Array.isArray(sunoData.response)) {
      tracks = sunoData.response;
    }

    if (tracks.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Suno task found but no tracks returned yet. Try again in 30 seconds.",
          raw_status: sunoData.data?.status || sunoData.status || "unknown",
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── UPDATE BEATS WITH SUNO DATA ────────────────────────────────
    const updated: any[] = [];

    for (let i = 0; i < Math.min(tracks.length, beats.length); i++) {
      const track = tracks[i];
      const beat = beats[i];

      const audioUrl = track.audio_url || track.audioUrl || track.audio || track.song_url || null;
      const streamUrl = track.stream_url || track.streamUrl || track.stream || null;
      const imageUrl = track.image_url || track.imageUrl || track.image_large_url || track.image || null;
      const trackId = track.id || track.sunoId || track.suno_id || null;
      const trackStatus = track.status || "unknown";

      // Only update if the track actually has audio (never mark complete without audio_url)
      if (audioUrl) {
        const updateData: Record<string, any> = {
          status: "complete",
          suno_id: trackId || beat.suno_id,
        };
        if (audioUrl) updateData.audio_url = audioUrl;
        if (streamUrl || audioUrl) updateData.stream_url = streamUrl || audioUrl;
        if (imageUrl) updateData.image_url = imageUrl;
        if (track.duration) updateData.duration = Math.round(track.duration);

        await supabase.from("beats").update(updateData).eq("id", beat.id);
        updated.push({ id: beat.id, title: beat.title, status: "complete" });
        console.log(`Beat ${beat.id} (${beat.title}) → complete via manual poll`);
      } else {
        updated.push({ id: beat.id, title: beat.title, status: beat.status, trackStatus });
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
