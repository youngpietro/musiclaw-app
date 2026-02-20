// supabase/functions/suno-callback/index.ts
// POST /functions/v1/suno-callback
// Receives Suno API callbacks with beat generation status updates
// SECURITY: Optional secret validation, robust payload parsing
// Handles multiple Suno API callback formats (v1 + v2 + edge cases)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Helper: extract audio URL from a track object (handles many naming conventions)
function extractAudioUrl(track: any): string | null {
  return track.audio_url || track.audioUrl || track.audio || track.song_url || track.songUrl || null;
}

function extractStreamUrl(track: any): string | null {
  return track.stream_url || track.streamUrl || track.stream || null;
}

function extractImageUrl(track: any): string | null {
  return track.image_url || track.imageUrl || track.image_large_url || track.imageLargeUrl || track.image || null;
}

function extractTrackId(track: any): string | null {
  return track.id || track.sunoId || track.suno_id || track.song_id || track.songId || null;
}

// Helper: determine if a track looks "complete" (has audio)
function trackHasAudio(track: any): boolean {
  return !!extractAudioUrl(track);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── OPTIONAL SECRET VALIDATION ──────────────────────────────────
    const url = new URL(req.url);
    const expectedSecret = Deno.env.get("SUNO_CALLBACK_SECRET") || "";
    if (expectedSecret) {
      const providedSecret = url.searchParams.get("secret") || "";
      if (providedSecret !== expectedSecret) {
        console.warn("Suno callback: invalid secret");
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const payload = await req.json();
    console.log("Suno callback received:", JSON.stringify(payload).slice(0, 1000));

    // ─── FLEXIBLE PAYLOAD PARSING ────────────────────────────────────
    // Suno API sends callbacks in multiple formats:
    //   Format A: { data: { callbackType: "complete", taskId, data: [tracks] } }
    //   Format B: { stage: "complete", taskId, data: [tracks] }
    //   Format C: { status: "complete", task_id, output: [tracks] }
    //   Format D: { code: 200, data: { taskId, callbackType, data: [tracks] } }
    //   Format E: { event: "complete", taskId, songs: [tracks] }

    let stage: string | null = null;
    let taskId: string | null = null;
    let tracks: any[] = [];

    // Try Format A / D (nested data object)
    if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
      const inner = payload.data;
      stage = inner.callbackType || inner.stage || inner.status || inner.event || null;
      taskId = inner.taskId || inner.task_id || payload.taskId || payload.task_id || null;
      tracks = inner.data || inner.output || inner.songs || inner.tracks || [];
      if (!Array.isArray(tracks)) tracks = [];
    }

    // Try Format B / C / E (flat)
    if (!stage) {
      stage = payload.stage || payload.status || payload.callbackType || payload.event || null;
    }
    if (!taskId) {
      taskId = payload.taskId || payload.task_id || null;
    }
    if (tracks.length === 0) {
      const rawTracks = payload.data || payload.output || payload.songs || payload.tracks || [];
      if (Array.isArray(rawTracks)) tracks = rawTracks;
    }

    // Normalize stage to lowercase
    if (stage) stage = String(stage).toLowerCase().trim();

    // Auto-detect stage from track content if stage is missing or unknown
    const isComplete = stage === "complete" || stage === "done" || stage === "finished" || stage === "success";
    const isFirst = stage === "first" || stage === "streaming" || stage === "partial";
    const tracksHaveAudio = tracks.length > 0 && tracks.some(trackHasAudio);

    // If stage is unrecognized but tracks have audio URLs, treat as complete
    const effectiveComplete = isComplete || (!isFirst && tracksHaveAudio);

    console.log(`Parsed — stage: ${stage}, effectiveComplete: ${effectiveComplete}, taskId: ${taskId}, tracks: ${tracks.length}, tracksHaveAudio: ${tracksHaveAudio}`);

    // ─── FIND MATCHING BEATS ─────────────────────────────────────────
    let beats: any[] = [];

    // Strategy 1: Match by task_id
    if (taskId) {
      const { data } = await supabase
        .from("beats").select("*").eq("task_id", taskId)
        .order("created_at", { ascending: true });
      if (data?.length) beats = data;
    }

    // Strategy 2: Match by suno_id from tracks
    if (beats.length === 0 && tracks.length > 0) {
      const trackIds = tracks.map(extractTrackId).filter(Boolean);
      if (trackIds.length > 0) {
        const { data } = await supabase
          .from("beats").select("*").in("suno_id", trackIds)
          .order("created_at", { ascending: true });
        if (data?.length) beats = data;
      }
    }

    // Strategy 3: Fallback to most recent "generating" beats
    if (beats.length === 0) {
      const { data } = await supabase
        .from("beats").select("*").eq("status", "generating")
        .order("created_at", { ascending: false }).limit(2);
      if (data?.length) beats = data.reverse();
    }

    if (beats.length === 0) {
      console.log("Suno callback: no matching beats found");
      return new Response(
        JSON.stringify({ ok: true, message: "No matching beats" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${beats.length} matching beats: ${beats.map(b => b.id).join(", ")}`);

    // ─── UPDATE BEATS ────────────────────────────────────────────────
    if (effectiveComplete && tracks.length > 0) {
      for (let i = 0; i < Math.min(tracks.length, beats.length); i++) {
        const track = tracks[i];
        const beat = beats[i];
        const audioUrl = extractAudioUrl(track);
        const streamUrl = extractStreamUrl(track);
        const imageUrl = extractImageUrl(track);
        const trackId = extractTrackId(track);

        await supabase.from("beats").update({
          status: "complete",
          suno_id: trackId || beat.suno_id,
          audio_url: audioUrl || beat.audio_url,
          // Set stream_url from track; if not available, use audio_url as fallback for playback
          stream_url: streamUrl || audioUrl || beat.stream_url,
          image_url: imageUrl || beat.image_url,
          duration: track.duration ? Math.round(track.duration) : beat.duration,
        }).eq("id", beat.id);

        console.log(`Beat ${beat.id} (${beat.title}) → complete. audio: ${!!audioUrl}, stream: ${!!(streamUrl || audioUrl)}`);
      }

      // Award karma to the agent
      if (beats.length > 0) {
        const agentId = beats[0].agent_id;
        const { data: agent } = await supabase
          .from("agents").select("karma").eq("id", agentId).single();
        if (agent) {
          await supabase.from("agents").update({ karma: agent.karma + 5 }).eq("id", agentId);
        }
      }
    } else if (isFirst && tracks.length > 0) {
      for (let i = 0; i < Math.min(tracks.length, beats.length); i++) {
        const track = tracks[i];
        const beat = beats[i];
        await supabase.from("beats").update({
          stream_url: extractStreamUrl(track) || beat.stream_url,
          suno_id: extractTrackId(track) || beat.suno_id,
          duration: track.duration ? Math.round(track.duration) : beat.duration,
        }).eq("id", beat.id);
        console.log(`Beat ${beat.id} (${beat.title}) → first stage update`);
      }
    } else {
      console.log(`Suno callback: unhandled — stage="${stage}", effectiveComplete=${effectiveComplete}, tracks=${tracks.length}`);
    }

    return new Response(
      JSON.stringify({ success: true, stage, effectiveComplete, beats_updated: beats.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Callback error:", err.message);
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
