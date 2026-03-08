// supabase/functions/poll-stems/index.ts
// POST /functions/v1/poll-stems
// Headers: Authorization: Bearer <agent_api_token>
// Body: { beat_id, suno_cookie? }
// Polls self-hosted Suno API for stem clip completion.
// Use when process-stems timed out (stems stuck in "processing").
// On completion: creates sample rows, uploads to Supabase Storage.
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

    let { data: agent } = await supabase.from("agents").select("id, handle, suno_self_hosted_url").eq("api_token_hash", tokenHash).single();
    if (!agent) {
      const { data: fallback } = await supabase.from("agents").select("id, handle, suno_self_hosted_url").eq("api_token", token).single();
      agent = fallback;
    }

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Invalid API token" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: max 20 polls per hour per agent ───────────────
    const { data: recentPolls } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "poll_stems")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentPolls && recentPolls.length >= 20) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 20 stem polls per hour." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({ action: "poll_stems", identifier: agent.id });

    // ─── VALIDATE INPUT ──────────────────────────────────────────────
    const body = await req.json();
    const { beat_id, suno_cookie: inlineCookie } = body;

    if (!beat_id) {
      return new Response(
        JSON.stringify({ error: "beat_id is required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP BEAT ────────────────────────────────────────────────
    const { data: beat } = await supabase
      .from("beats")
      .select("id, title, suno_id, agent_id, stems_status, stems_clip_ids, stems, generation_source")
      .eq("id", beat_id)
      .eq("agent_id", agent.id)
      .single();

    if (!beat) {
      return new Response(
        JSON.stringify({ error: "Beat not found or does not belong to you" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (beat.stems_status === "complete") {
      return new Response(
        JSON.stringify({
          success: true,
          message: "Stems are already complete.",
          stems: beat.stems,
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (beat.stems_status !== "processing") {
      return new Response(
        JSON.stringify({ error: `Stems are not processing (status: ${beat.stems_status}). Call process-stems first.` }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const stemClipIds: string[] = beat.stems_clip_ids || [];
    if (stemClipIds.length === 0) {
      return new Response(
        JSON.stringify({ error: "No stem clip IDs found. Stems may not have been triggered properly. Call process-stems again." }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RESOLVE CREDENTIALS ────────────────────────────────────────
    const generationSource = beat.generation_source || "sunoapi";
    const useSelfHosted = generationSource === "selfhosted";

    if (!useSelfHosted) {
      return new Response(
        JSON.stringify({ error: "poll-stems is for self-hosted beats only. sunoapi.org beats use callbacks." }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    let effectiveCookie = inlineCookie || null;
    if (!effectiveCookie) {
      const { data: agentFull } = await supabase
        .from("agents").select("suno_cookie").eq("id", agent.id).single();
      effectiveCookie = agentFull?.suno_cookie || null;
    }
    if (!effectiveCookie) {
      effectiveCookie = Deno.env.get("SUNO_SELF_HOSTED_COOKIE") || null;
    }

    if (!effectiveCookie) {
      return new Response(
        JSON.stringify({ error: "suno_cookie is required. Pass it in the request or store it via update-agent-settings." }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const selfHostedUrl = agent.suno_self_hosted_url || Deno.env.get("SUNO_SELF_HOSTED_URL");
    if (!selfHostedUrl) {
      return new Response(
        JSON.stringify({ error: "No self-hosted Suno API URL configured." }),
        { status: 503, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── POLL STEM CLIPS ────────────────────────────────────────────
    console.log(`Polling stem clips for beat ${beat.id}: ${stemClipIds.join(",")}`);

    const pollRes = await fetch(`${selfHostedUrl}/api/get?ids=${stemClipIds.join(",")}`, {
      method: "GET",
      headers: { "X-Suno-Cookie": effectiveCookie },
    });

    if (!pollRes.ok) {
      const errText = await pollRes.text();
      const isSessionExpired = errText.includes("Failed to get session id") || errText.includes("update the SUNO_COOKIE") || pollRes.status === 401;
      if (isSessionExpired) {
        return new Response(
          JSON.stringify({ error: "Suno session expired. Re-submit a fresh cookie via update-agent-settings." }),
          { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ error: `Self-hosted API returned ${pollRes.status}` }),
        { status: 502, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const pollData = await pollRes.json();
    const clips = Array.isArray(pollData) ? pollData : (pollData?.clips || pollData?.data || []);

    const readyClips = clips.filter((c: any) => c.audio_url && (c.status === "complete" || c.status === "streaming"));
    console.log(`Stem poll: ${readyClips.length}/${stemClipIds.length} clips ready`);

    if (readyClips.length < stemClipIds.length) {
      return new Response(
        JSON.stringify({
          success: false,
          message: `Stems still processing: ${readyClips.length}/${stemClipIds.length} ready. Try again in 30 seconds.`,
          clips_ready: readyClips.length,
          clips_total: stemClipIds.length,
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── ALL STEMS READY — EXTRACT AND PROCESS ──────────────────────
    const KNOWN_STEMS = ["bass", "drums", "vocals", "other", "melody", "piano", "guitar", "strings", "wind"];
    const completedStems: Record<string, string> = {};

    for (const clip of readyClips) {
      let stemType = "unknown";
      const title = (clip.title || "").toLowerCase();
      for (const stem of KNOWN_STEMS) {
        if (title.endsWith(` - ${stem}`) || title.includes(`_${stem}`) || title === stem) {
          stemType = stem;
          break;
        }
      }
      if (stemType === "unknown" && clip.metadata?.stem_type) {
        stemType = clip.metadata.stem_type.toLowerCase();
      }
      if (stemType === "unknown") {
        const idx = readyClips.indexOf(clip);
        const defaultOrder = ["vocals", "drums", "bass", "other"];
        stemType = defaultOrder[idx] || `stem_${idx}`;
      }

      let audioUrl = clip.audio_url;
      if (clip.id && (!audioUrl || audioUrl.includes("audiopipe.suno.ai"))) {
        audioUrl = `https://cdn1.suno.ai/${clip.id}.mp3`;
      }
      completedStems[stemType] = audioUrl;
    }

    // ─── UPDATE BEAT ────────────────────────────────────────────────
    await supabase.from("beats").update({
      stems: completedStems,
      stems_status: "complete",
    }).eq("id", beat.id);
    console.log(`Beat ${beat.id} stems complete via poll: ${Object.keys(completedStems).join(", ")}`);

    // ─── CREATE SAMPLE ROWS (with silence detection) ─────────────────
    const SILENCE_ENTROPY = 7.5;
    let samplesCreated = 0;
    let samplesSkipped = 0;

    for (const [stemType, stemUrl] of Object.entries(completedStems)) {
      try {
        const headRes = await fetch(stemUrl, { method: "HEAD" });
        const fileSize = parseInt(headRes.headers.get("content-length") || "0", 10);
        if (fileSize < 1000) { samplesSkipped++; continue; }

        let isSilent = false;
        try {
          const midpoint = Math.floor(fileSize / 2);
          const rangeStart = Math.max(0, midpoint - 16384);
          const rangeEnd = Math.min(fileSize - 1, midpoint + 16383);
          const partialRes = await fetch(stemUrl, { headers: { Range: `bytes=${rangeStart}-${rangeEnd}` } });
          const buf = new Uint8Array(await partialRes.arrayBuffer());
          const freq = new Array(256).fill(0);
          for (let i = 0; i < buf.length; i++) freq[buf[i]]++;
          let entropy = 0;
          for (let i = 0; i < 256; i++) {
            if (freq[i] === 0) continue;
            const p = freq[i] / buf.length;
            entropy -= p * Math.log2(p);
          }
          isSilent = entropy < SILENCE_ENTROPY;
          console.log(`Stem ${stemType}: ${fileSize}B, entropy=${entropy.toFixed(3)}, silent=${isSilent}`);
        } catch (rangeErr) {
          console.warn(`Range request failed for ${stemType}: ${(rangeErr as Error).message}`);
        }

        if (isSilent) { samplesSkipped++; continue; }

        const { error: sampleErr } = await supabase.from("samples").upsert(
          { beat_id: beat.id, stem_type: stemType, audio_url: stemUrl, file_size: fileSize, audio_amplitude: fileSize },
          { onConflict: "beat_id,stem_type" }
        );
        if (sampleErr) console.error(`Sample insert error ${stemType}: ${sampleErr.message}`);
        else samplesCreated++;
      } catch (fetchErr) {
        console.warn(`Stem fetch failed for ${stemType}: ${(fetchErr as Error).message}`);
      }
    }
    console.log(`Samples for beat ${beat.id}: ${samplesCreated} created, ${samplesSkipped} skipped`);

    // ─── AUTO-UPLOAD STEMS TO SUPABASE STORAGE (fire-and-forget) ─────
    (async () => {
      try {
        let stemsUploaded = 0;
        for (const [stemType, stemUrl] of Object.entries(completedStems)) {
          try {
            const res = await fetch(stemUrl);
            if (res.ok) {
              const data = new Uint8Array(await res.arrayBuffer());
              await supabase.storage.from("audio").upload(
                `beats/${beat.id}/stems/${stemType}.mp3`, data,
                { contentType: "audio/mpeg", upsert: true }
              );
              stemsUploaded++;
            }
          } catch (e) {
            console.error(`Storage: stem upload failed ${stemType}: ${(e as Error).message}`);
          }
        }
        if (stemsUploaded > 0) {
          await supabase.from("samples").update({ storage_migrated: true }).eq("beat_id", beat.id);
          console.log(`Storage: uploaded ${stemsUploaded} stems for beat ${beat.id}`);
        }
      } catch (uploadErr) {
        console.error(`Storage: stems upload error: ${(uploadErr as Error).message}`);
      }
    })();

    return new Response(
      JSON.stringify({
        success: true,
        beat_id: beat.id,
        beat_title: beat.title,
        stems: completedStems,
        stem_count: Object.keys(completedStems).length,
        samples_created: samplesCreated,
        samples_skipped: samplesSkipped,
        message: `Stems complete: ${Object.keys(completedStems).join(", ")}. ${samplesCreated} samples created for sample library.`,
      }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Poll stems error:", err.message);
    return new Response(
      JSON.stringify({ error: "Failed to poll stems. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
