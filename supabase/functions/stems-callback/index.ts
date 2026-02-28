// supabase/functions/stems-callback/index.ts
// POST /functions/v1/stems-callback
// Receives callbacks from Suno stem splitting API (api.sunoapi.org)
// Updates the beat record with stem URLs as JSONB
// SECURITY: Required secret validation via query param

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

    // ─── SECRET VALIDATION ──────────────────────────────────────────
    const url = new URL(req.url);
    const expectedSecret = Deno.env.get("SUNO_CALLBACK_SECRET");
    if (!expectedSecret) {
      console.error("SUNO_CALLBACK_SECRET not configured — rejecting callback");
      return new Response(
        JSON.stringify({ error: "Server misconfigured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const providedSecret = url.searchParams.get("secret") || "";
    if (providedSecret !== expectedSecret) {
      console.warn("Stems callback: invalid secret");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── EXTRACT BEAT ID FROM QUERY ─────────────────────────────────
    const beatId = url.searchParams.get("beat_id");
    if (!beatId) {
      console.error("Stems callback: missing beat_id query param");
      return new Response(
        JSON.stringify({ error: "beat_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── IDEMPOTENCY: skip if beat is sold, deleted, or stems already done ─
    const { data: beatCheck } = await supabase
      .from("beats")
      .select("id, sold, deleted_at, stems_status")
      .eq("id", beatId)
      .single();

    if (!beatCheck) {
      console.warn(`Stems callback: beat ${beatId} not found`);
      return new Response(
        JSON.stringify({ ok: true, message: "Beat not found" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (beatCheck.sold || beatCheck.deleted_at) {
      console.log(`Stems callback: beat ${beatId} is ${beatCheck.sold ? "sold" : "deleted"} — skipping`);
      return new Response(
        JSON.stringify({ ok: true, message: "Beat already finalized" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (beatCheck.stems_status === "complete") {
      console.log(`Stems callback: beat ${beatId} stems already complete — skipping`);
      return new Response(
        JSON.stringify({ ok: true, message: "Stems already complete" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── PARSE CALLBACK PAYLOAD ─────────────────────────────────────
    const rawBody = await req.text();
    console.log(`Stems callback RAW for beat ${beatId}: ${rawBody.slice(0, 3000)}`);

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch (parseErr) {
      console.error(`Stems callback: invalid JSON for beat ${beatId}: ${rawBody.slice(0, 200)}`);
      await supabase.from("beats").update({ stems_status: "failed" }).eq("id", beatId);
      return new Response(
        JSON.stringify({ error: "Invalid JSON in callback body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Actual API callback format from vocal-removal/split_stem:
    // {
    //   "code": 200,
    //   "data": {
    //     "task_id": "...",
    //     "vocal_removal_info": {
    //       "vocal_url": "https://..._Vocals.mp3",
    //       "drums_url": "https://..._Drums.mp3",
    //       "bass_url": "https://..._Bass.mp3", ...
    //       "origin_url": ""  ← skip this one
    //     }
    //   },
    //   "msg": "vocal Removal generated successfully."
    // }
    const outerData = payload.data || payload;
    const status = payload.code || payload.status;
    const msg = payload.msg || payload.message || "";
    console.log(`Stems callback parsed for beat ${beatId}: code=${status}, msg=${msg}, outerData keys: ${Object.keys(outerData).join(",")}`);

    // Check for error/failure
    const isError = (status && status >= 400) || msg.toLowerCase().includes("failed") || msg.toLowerCase().includes("error");

    if (isError) {
      console.error(`Stems callback failed for beat ${beatId}: code=${status} msg=${msg}`);
      await supabase.from("beats").update({ stems_status: "failed" }).eq("id", beatId);
      return new Response(
        JSON.stringify({ ok: true, message: "Stem splitting failed, status updated" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── EXTRACT STEMS from vocal_removal_info ────────────────────────
    // The API returns a flat object with named *_url keys, NOT an array
    const vocalRemovalInfo = outerData.vocal_removal_info
      || outerData.vocalRemovalInfo
      || outerData.vocal_removal
      || null;

    // Helper: validate URL format — must be valid HTTPS URL
    function isValidMediaUrl(u: string): boolean {
      try { return new URL(u).protocol === "https:"; }
      catch { return false; }
    }

    const stems: Record<string, string> = {};

    if (vocalRemovalInfo && typeof vocalRemovalInfo === "object") {
      // Format: { vocal_url: "...", drums_url: "...", bass_url: "...", origin_url: "" }
      for (const [key, value] of Object.entries(vocalRemovalInfo)) {
        if (!value || typeof value !== "string" || value === "") continue;
        if (key === "origin_url") continue; // skip original track reference
        if (!isValidMediaUrl(value as string)) {
          console.warn(`Stems: skipping invalid URL for ${key}: ${String(value).slice(0, 80)}`);
          continue;
        }
        // Strip _url suffix to get stem name: "drums_url" → "drums", "backing_vocals_url" → "backing_vocals"
        const stemName = key.replace(/_url$/, "");
        stems[stemName] = value as string;
      }
      console.log(`Stems from vocal_removal_info: ${Object.keys(stems).join(", ")} (${Object.keys(stems).length} stems)`);
    }

    // Fallback: try legacy array format (in case API ever changes back)
    if (Object.keys(stems).length === 0) {
      const stemTracks = outerData.data || outerData.output || outerData.tracks || outerData.stems || [];
      if (Array.isArray(stemTracks)) {
        for (const stem of stemTracks) {
          const stemType = stem.type || stem.stem_type || stem.name || stem.label || "unknown";
          const stemUrl = stem.audioUrl || stem.audio_url || stem.url || null;
          if (stemType && stemUrl && isValidMediaUrl(stemUrl)) {
            stems[String(stemType).toLowerCase().replace(/\s+/g, "_")] = stemUrl;
          }
        }
        if (Object.keys(stems).length > 0) {
          console.log(`Stems from legacy array: ${Object.keys(stems).join(", ")} (${Object.keys(stems).length} stems)`);
        }
      }
    }

    if (Object.keys(stems).length === 0) {
      console.error(`Stems callback: could not extract any stem URLs for beat ${beatId}. outerData keys: ${Object.keys(outerData).join(",")}, payload keys: ${Object.keys(payload).join(",")}`);
      await supabase.from("beats").update({ stems_status: "failed" }).eq("id", beatId);
      return new Response(
        JSON.stringify({ ok: true, message: "Could not extract stem URLs from callback" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── UPDATE BEAT WITH STEMS ─────────────────────────────────────
    const { error: updateErr } = await supabase
      .from("beats")
      .update({ stems, stems_status: "complete" })
      .eq("id", beatId);

    if (updateErr) throw updateErr;

    console.log(`Beat ${beatId} stems complete: ${Object.keys(stems).join(", ")} (${Object.keys(stems).length} stems)`);

    // ─── CREATE SAMPLE ROWS FOR SAMPLE LIBRARY ────────────────────────
    // Silence detection: compare each stem's file size to the median of all
    // sibling stems. Silent MP3s compress much smaller. < 50% of median = silent.
    let samplesCreated = 0;
    let samplesSkipped = 0;

    // Pass 1: HEAD all stems to collect file sizes
    const stemSizes: Record<string, number> = {};
    for (const [stemType, stemUrl] of Object.entries(stems)) {
      try {
        const headRes = await fetch(stemUrl, { method: "HEAD" });
        stemSizes[stemType] = parseInt(headRes.headers.get("content-length") || "0", 10);
      } catch {
        stemSizes[stemType] = 0;
      }
    }

    // Compute median file size across all stems
    const sizes = Object.values(stemSizes).filter(s => s > 0).sort((a, b) => a - b);
    const mid = Math.floor(sizes.length / 2);
    const medianSize = sizes.length === 0 ? 0 : sizes.length % 2 !== 0 ? sizes[mid] : (sizes[mid - 1] + sizes[mid]) / 2;
    const threshold = medianSize * 0.5;
    console.log(`Beat ${beatId} stem sizes: ${JSON.stringify(stemSizes)}, median=${medianSize}, threshold=${threshold}`);

    // Pass 2: Insert samples, skip silent ones
    for (const [stemType, stemUrl] of Object.entries(stems)) {
      const fileSize = stemSizes[stemType] || 0;
      const isSilent = fileSize < threshold || fileSize < 1000;

      if (isSilent) {
        console.log(`Sample skip: ${stemType} for beat ${beatId} — silent (${fileSize} bytes, median=${medianSize})`);
        samplesSkipped++;
        continue;
      }

      try {
        const { error: sampleErr } = await supabase
          .from("samples")
          .upsert(
            { beat_id: beatId, stem_type: stemType, audio_url: stemUrl, file_size: fileSize, audio_amplitude: fileSize },
            { onConflict: "beat_id,stem_type" }
          );
        if (sampleErr) {
          console.error(`Sample insert error for ${stemType} beat ${beatId}:`, sampleErr.message);
        } else {
          samplesCreated++;
        }
      } catch (insertErr) {
        console.warn(`Insert failed for ${stemType} beat ${beatId}: ${(insertErr as Error).message}`);
      }
    }
    console.log(`Samples for beat ${beatId}: ${samplesCreated} created, ${samplesSkipped} skipped (silent)`);

    return new Response(
      JSON.stringify({ success: true, beat_id: beatId, stem_count: Object.keys(stems).length, samples_created: samplesCreated }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Stems callback error:", err.message);
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
