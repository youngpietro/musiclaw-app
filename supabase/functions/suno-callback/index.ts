// supabase/functions/suno-callback/index.ts
// POST /functions/v1/suno-callback
// Receives Suno API callbacks with beat generation status updates
// Also handles stems callbacks (?type=stems&beat_id=X) from sunoapi.org
// SECURITY: Required secret validation
// Uses shared parseCallback() for normalized payload parsing

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

// Helper: validate URL format — must be valid HTTPS URL
function isValidMediaUrl(url: string | null): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch { return false; }
}

// Stem types that should NOT become purchasable samples
// (same as services/stem-processor/src/constants.ts EXCLUDED_SAMPLE_TYPES)
const EXCLUDED_SAMPLE_TYPES = new Set([
  "vocals",
  "vocal",
  "backing_vocals",
  "lead_vocals",
  "instrumental",
  "instrum",
]);

// All possible stem types from sunoapi.org split_stem callback
const KNOWN_STEM_TYPES = [
  "vocals", "backing_vocals", "drums", "bass", "guitar",
  "keyboard", "strings", "brass", "woodwinds", "percussion",
  "synth", "fx",
];

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── SECRET VALIDATION (required) ──────────────────────────────────
    const url = new URL(req.url);
    const expectedSecret = Deno.env.get("SUNO_CALLBACK_SECRET");
    if (!expectedSecret) {
      console.error("SUNO_CALLBACK_SECRET not configured — rejecting all callbacks");
      return new Response(
        JSON.stringify({ error: "Server misconfigured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // Check header first (preferred), fall back to query param (legacy)
    const providedSecret = req.headers.get("x-callback-secret") || url.searchParams.get("secret") || "";
    if (providedSecret !== expectedSecret) {
      console.warn("Suno callback: invalid secret");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── PARSE CALLBACK USING SHARED MODULE ───────────────────────────
    const { parseCallback } = await import("../_shared/suno-providers.ts");
    const raw = await req.json();
    console.log("Callback received:", JSON.stringify(raw).slice(0, 1000));
    const parsed = parseCallback(raw);

    // ─── STEMS CALLBACK HANDLING ──────────────────────────────────────
    // URL: ?type=stems&beat_id=X
    const callbackType = url.searchParams.get("type");
    const stemsBeatId = url.searchParams.get("beat_id");

    if (callbackType === "stems" && stemsBeatId) {
      console.log(`Stems callback for beat ${stemsBeatId}`);

      // Look up the beat
      const { data: beat } = await supabase
        .from("beats").select("*").eq("id", stemsBeatId).single();

      if (!beat) {
        console.log(`Stems callback: beat ${stemsBeatId} not found`);
        return new Response(
          JSON.stringify({ ok: true, message: "Beat not found" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Idempotency: skip if already complete, sold, or deleted
      if (beat.stems_status === "complete") {
        console.log(`Beat ${beat.id} stems already complete — skipping`);
        return new Response(
          JSON.stringify({ ok: true, message: "Stems already complete" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (beat.sold || beat.deleted_at) {
        console.log(`Beat ${beat.id} is ${beat.sold ? "sold" : "deleted"} — skipping stems`);
        return new Response(
          JSON.stringify({ ok: true, message: "Beat sold or deleted" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Parse stem URLs from the callback payload
      // sunoapi.org returns stems in parsed.tracks, each with audioUrl and title (stem type)
      // Or the raw payload may contain data[] with audio_url for each stem type
      const stemTracks = parsed.tracks.length > 0 ? parsed.tracks : [];

      // Also check for raw stem data in various formats
      const rawStems: { type: string; url: string }[] = [];

      // Format 1: parsed.tracks with title as stem type
      for (const track of stemTracks) {
        if (track.audioUrl && track.title) {
          const stemType = track.title.toLowerCase()
            .replace(/\s*\(.*?\)\s*/g, "")
            .replace(/[^a-z0-9_]+/g, "_")
            .replace(/^_|_$/g, "");
          if (stemType && isValidMediaUrl(track.audioUrl)) {
            rawStems.push({ type: stemType, url: track.audioUrl });
          }
        }
      }

      // Format 2: raw payload has stem-specific fields (e.g., data[] with type/audio_url)
      if (rawStems.length === 0 && Array.isArray(raw.data)) {
        for (const item of raw.data) {
          const stemType = (item.type || item.stem_type || item.title || item.name || "")
            .toLowerCase()
            .replace(/\s*\(.*?\)\s*/g, "")
            .replace(/[^a-z0-9_]+/g, "_")
            .replace(/^_|_$/g, "");
          const stemUrl = item.audio_url || item.audioUrl || item.url || "";
          if (stemType && isValidMediaUrl(stemUrl)) {
            rawStems.push({ type: stemType, url: stemUrl });
          }
        }
      }

      if (rawStems.length === 0) {
        console.warn(`Stems callback for beat ${stemsBeatId}: no stem URLs found in payload`);
        return new Response(
          JSON.stringify({ ok: true, message: "No stems in payload" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`Found ${rawStems.length} stems for beat ${stemsBeatId}: ${rawStems.map(s => s.type).join(", ")}`);

      // Upload each stem to R2 and create sample records (fire-and-forget)
      const { r2Upload, r2PublicUrl } = await import("../_shared/r2.ts");
      const storedStems: Record<string, string> = {};
      let samplesCreated = 0;

      for (const stem of rawStems) {
        try {
          // Download stem audio from provider CDN
          const stemRes = await fetch(stem.url);
          if (!stemRes.ok) {
            console.warn(`Failed to download stem ${stem.type} for beat ${stemsBeatId}: ${stemRes.status}`);
            continue;
          }
          const stemData = new Uint8Array(await stemRes.arrayBuffer());
          const fileSize = stemData.length;

          // Skip tiny/empty files
          if (fileSize < 1000) {
            console.log(`Skipping stem ${stem.type}: too small (${fileSize} bytes)`);
            continue;
          }

          // Upload to R2: beats/{beatId}/stems/{stemType}.mp3
          const storagePath = `beats/${stemsBeatId}/stems/${stem.type}.mp3`;
          await r2Upload(storagePath, stemData, "audio/mpeg");
          console.log(`R2: uploaded stem ${stem.type} for beat ${stemsBeatId}`);

          const publicUrl = r2PublicUrl(storagePath);
          storedStems[stem.type] = publicUrl;

          // Create sample record for non-excluded stems
          if (!EXCLUDED_SAMPLE_TYPES.has(stem.type)) {
            const { error: sampleErr } = await supabase.from("samples").upsert(
              {
                beat_id: stemsBeatId,
                stem_type: stem.type,
                audio_url: publicUrl,
                file_size: fileSize,
                audio_amplitude: fileSize,
                storage_migrated: true,
              },
              { onConflict: "beat_id,stem_type" }
            );
            if (sampleErr) {
              console.error(`Sample insert error ${stem.type}: ${sampleErr.message}`);
            } else {
              samplesCreated++;
            }
          } else {
            console.log(`Skipping sample for ${stem.type}: excluded type`);
          }
        } catch (stemErr) {
          console.error(`Stem processing error for ${stem.type}:`, (stemErr as Error).message);
        }
      }

      // Update beat: stems_status = "complete", stems = { type: url, ... }
      await supabase.from("beats").update({
        stems_status: "complete",
        stems: storedStems,
      }).eq("id", stemsBeatId);

      console.log(`Beat ${stemsBeatId} stems complete: ${Object.keys(storedStems).length} stems stored, ${samplesCreated} samples created`);

      return new Response(
        JSON.stringify({
          success: true,
          beat_id: stemsBeatId,
          stems_stored: Object.keys(storedStems).length,
          samples_created: samplesCreated,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── NORMAL GENERATION CALLBACK ───────────────────────────────────
    const taskId = parsed.taskId;
    const tracks = parsed.tracks;

    // Determine if this is a completion callback
    const cbType = parsed.callbackType.toLowerCase();
    const isComplete = cbType === "complete" || cbType === "done" || cbType === "finished" || cbType === "success";
    const isFirst = cbType === "first" || cbType === "streaming" || cbType === "partial";
    const tracksHaveAudio = tracks.length > 0 && tracks.some(t => !!t.audioUrl);

    // If callbackType is unrecognized but tracks have audio URLs, treat as complete
    const effectiveComplete = isComplete || (!isFirst && tracksHaveAudio);

    console.log(`Parsed — callbackType: ${parsed.callbackType}, effectiveComplete: ${effectiveComplete}, taskId: ${taskId}, tracks: ${tracks.length}, tracksHaveAudio: ${tracksHaveAudio}, provider: ${parsed.provider}`);

    // ─── FIND MATCHING BEAT ──────────────────────────────────────────
    let beat: any = null;

    if (taskId) {
      const { data } = await supabase
        .from("beats").select("*").eq("task_id", taskId)
        .order("created_at", { ascending: true })
        .limit(1)
        .single();
      if (data) beat = data;
    }

    if (!beat) {
      console.log("Suno callback: no matching beat found");
      return new Response(
        JSON.stringify({ ok: true, message: "No matching beat" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found matching beat: ${beat.id} (${beat.title})`);

    // ─── UPDATE BEAT(S) ──────────────────────────────────────────────
    if (effectiveComplete && tracks.length > 0) {
      // Process track 1 → existing beat
      const track1 = tracks[0];

      // IDEMPOTENCY: skip beats that are already sold, deleted, or complete
      if (beat.sold || beat.deleted_at) {
        console.log(`Beat ${beat.id} is ${beat.sold ? "sold" : "deleted"} — skipping callback update`);
      } else if (beat.status === "complete") {
        console.log(`Beat ${beat.id} already complete — skipping callback update`);
      } else {
        const audioUrl = track1.audioUrl;
        const streamUrl = track1.streamUrl;
        const imageUrl = track1.imageUrl;
        const songId = track1.songId;

        if (audioUrl && isValidMediaUrl(audioUrl)) {
          await supabase.from("beats").update({
            status: "complete",
            suno_id: songId || beat.suno_id,
            audio_url: audioUrl,
            stream_url: isValidMediaUrl(streamUrl) ? streamUrl : (audioUrl || beat.stream_url),
            image_url: isValidMediaUrl(imageUrl) ? imageUrl : beat.image_url,
            duration: track1.duration ? Math.round(track1.duration) : beat.duration,
          }).eq("id", beat.id);
          console.log(`Beat ${beat.id} (${beat.title}) → complete`);
        } else if (audioUrl && !isValidMediaUrl(audioUrl)) {
          await supabase.from("beats").update({
            status: "failed",
            deleted_at: new Date().toISOString(),
            suno_id: songId || beat.suno_id,
          }).eq("id", beat.id);
          console.warn(`Beat ${beat.id} (${beat.title}) → FAILED + deleted: invalid audio_url format: ${String(audioUrl).slice(0, 100)}`);
        } else {
          await supabase.from("beats").update({
            status: "failed",
            deleted_at: new Date().toISOString(),
            suno_id: songId || beat.suno_id,
          }).eq("id", beat.id);
          console.warn(`Beat ${beat.id} (${beat.title}) → FAILED + deleted: no audio_url in callback`);
        }
      }

      // Process track 2 → create v2 variant beat if present
      let v2Beat: any = null;
      if (tracks.length >= 2) {
        const track2 = tracks[1];
        const audioUrl2 = track2.audioUrl;

        if (audioUrl2 && isValidMediaUrl(audioUrl2)) {
          // Create a second beat record as "(v2)" variant
          const v2Insert: Record<string, unknown> = {
            agent_id: beat.agent_id,
            title: `${beat.title} (v2)`,
            genre: beat.genre,
            sub_genre: beat.sub_genre,
            style: beat.style,
            model: beat.model,
            bpm: beat.bpm,
            instrumental: beat.instrumental,
            negative_tags: beat.negative_tags,
            task_id: beat.task_id,
            status: "complete",
            price: beat.price,
            stems_price: beat.stems_price,
            generation_source: beat.generation_source,
            suno_id: track2.songId || null,
            audio_url: audioUrl2,
            stream_url: isValidMediaUrl(track2.streamUrl) ? track2.streamUrl : audioUrl2,
            image_url: isValidMediaUrl(track2.imageUrl) ? track2.imageUrl : beat.image_url,
            duration: track2.duration ? Math.round(track2.duration) : beat.duration,
          };

          const { data: newBeat, error: v2Err } = await supabase
            .from("beats").insert(v2Insert).select().single();

          if (v2Err) {
            console.error(`Failed to create v2 beat for ${beat.id}: ${v2Err.message}`);
          } else {
            v2Beat = newBeat;
            console.log(`Created v2 beat ${newBeat.id} (${newBeat.title}) from track 2`);
          }
        }
      }

      // Award karma to the agent
      const agentId = beat.agent_id;
      const { data: agent } = await supabase
        .from("agents").select("karma").eq("id", agentId).single();
      if (agent) {
        await supabase.from("agents").update({ karma: agent.karma + 5 }).eq("id", agentId);
      }

      // ─── AUTO-UPLOAD TO R2 STORAGE (fire-and-forget) ──────────────
      // Download audio + image from provider CDN URLs, upload to R2.
      // This ensures new beats are immediately backed up before CDN URLs expire.
      const beatsToUpload: { beat: any; track: typeof tracks[0] }[] = [
        { beat, track: track1 },
      ];
      if (v2Beat && tracks.length >= 2) {
        beatsToUpload.push({ beat: v2Beat, track: tracks[1] });
      }

      for (const { beat: b, track: t } of beatsToUpload) {
        // Non-blocking upload — don't delay callback response
        (async () => {
          try {
            const { r2Upload } = await import("../_shared/r2.ts");
            // Upload MP3 audio
            if (t.audioUrl && isValidMediaUrl(t.audioUrl)) {
              const audioRes = await fetch(t.audioUrl);
              if (audioRes.ok) {
                const audioData = new Uint8Array(await audioRes.arrayBuffer());
                await r2Upload(`beats/${b.id}/track.mp3`, audioData, "audio/mpeg");
                console.log(`R2: uploaded audio for beat ${b.id}`);
              }
            }
            // Upload cover image
            if (t.imageUrl && isValidMediaUrl(t.imageUrl)) {
              const imgRes = await fetch(t.imageUrl);
              if (imgRes.ok) {
                const imgData = new Uint8Array(await imgRes.arrayBuffer());
                const ct = imgRes.headers.get("content-type") || "image/jpeg";
                await r2Upload(`beats/${b.id}/cover.jpg`, imgData, ct);
                console.log(`R2: uploaded cover for beat ${b.id}`);
              }
            }
            // Mark as migrated
            await supabase.from("beats").update({ storage_migrated: true }).eq("id", b.id);
            console.log(`R2: beat ${b.id} marked as migrated`);
          } catch (uploadErr) {
            console.error(`R2 upload error for beat ${b.id}:`, (uploadErr as Error).message);
            // Non-fatal — beat is still usable via CDN URLs until they expire
          }
        })();
      }

    } else if (isFirst && tracks.length > 0) {
      // First/streaming stage — update with partial info
      const track = tracks[0];
      await supabase.from("beats").update({
        stream_url: isValidMediaUrl(track.streamUrl) ? track.streamUrl : beat.stream_url,
        suno_id: track.songId || beat.suno_id,
        duration: track.duration ? Math.round(track.duration) : beat.duration,
      }).eq("id", beat.id);
      console.log(`Beat ${beat.id} (${beat.title}) → first stage update`);
    } else {
      console.log(`Suno callback: unhandled — callbackType="${parsed.callbackType}", effectiveComplete=${effectiveComplete}, tracks=${tracks.length}`);
    }

    return new Response(
      JSON.stringify({
        success: true, callbackType: parsed.callbackType, effectiveComplete, beats_updated: 1,
        ...(effectiveComplete ? { storage_upload: "auto-triggered", note: "Audio files auto-uploaded to R2 Storage." } : {}),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Callback error:", (err as Error).message);
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
