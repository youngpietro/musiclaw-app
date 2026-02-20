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

    const payload = await req.json();
    console.log("Suno callback received:", JSON.stringify(payload).slice(0, 500));

    let stage, taskId, tracks;

    if (payload.data && payload.data.callbackType) {
      stage = payload.data.callbackType;
      taskId = payload.data.taskId || payload.taskId || null;
      tracks = payload.data.data || [];
    } else {
      stage = payload.stage;
      taskId = payload.taskId;
      tracks = payload.data || [];
    }

    console.log(`Stage: ${stage}, TaskId: ${taskId}, Tracks: ${tracks.length}`);

    let beats = [];

    if (taskId) {
      const { data } = await supabase
        .from("beats").select("*").eq("task_id", taskId)
        .order("created_at", { ascending: true });
      if (data?.length) beats = data;
    }

    if (beats.length === 0 && tracks.length > 0) {
      const trackIds = tracks.map((t) => t.id).filter(Boolean);
      if (trackIds.length > 0) {
        const { data } = await supabase
          .from("beats").select("*").in("suno_id", trackIds)
          .order("created_at", { ascending: true });
        if (data?.length) beats = data;
      }
    }

    if (beats.length === 0) {
      const { data } = await supabase
        .from("beats").select("*").eq("status", "generating")
        .order("created_at", { ascending: false }).limit(2);
      if (data?.length) beats = data.reverse();
    }

    if (beats.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, message: "No matching beats" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (stage === "complete" && tracks.length > 0) {
      for (let i = 0; i < Math.min(tracks.length, beats.length); i++) {
        const track = tracks[i];
        const beat = beats[i];

        await supabase.from("beats").update({
          status: "complete",
          suno_id: track.id || track.sunoId || beat.suno_id,
          audio_url: track.audio_url || track.audioUrl || null,
          stream_url: track.stream_url || track.streamUrl || null,
          image_url: track.image_url || track.imageUrl || track.image_large_url || null,
          duration: track.duration ? Math.round(track.duration) : beat.duration,
        }).eq("id", beat.id);
      }

      if (beats.length > 0) {
        const agentId = beats[0].agent_id;
        const { data: agent } = await supabase
          .from("agents").select("karma").eq("id", agentId).single();
        if (agent) {
          await supabase.from("agents").update({ karma: agent.karma + 5 }).eq("id", agentId);
        }
      }
    } else if (stage === "first" && tracks.length > 0) {
      for (let i = 0; i < Math.min(tracks.length, beats.length); i++) {
        const track = tracks[i];
        const beat = beats[i];
        await supabase.from("beats").update({
          stream_url: track.stream_url || track.streamUrl || beat.stream_url,
          suno_id: track.id || track.sunoId || beat.suno_id,
          duration: track.duration ? Math.round(track.duration) : beat.duration,
        }).eq("id", beat.id);
      }
    }

    return new Response(
      JSON.stringify({ success: true, stage, beats_updated: beats.length }),
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
