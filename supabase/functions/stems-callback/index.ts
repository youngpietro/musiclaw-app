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

    // API response format from vocal-removal/split_stem:
    // { code: 200, data: { callbackType: "complete", data: [{ audioUrl, type, ... }] } }
    // Each stem item: { audioUrl, type: "vocals"|"drums"|"bass"|etc, duration, ... }
    const outerData = payload.data || payload;
    const callbackType = outerData.callbackType || outerData.callback_type || payload.callbackType || "";
    const status = payload.code || payload.status;
    console.log(`Stems callback parsed for beat ${beatId}: callbackType=${callbackType}, status=${status}`);

    // Check for error/failure
    const isError = (status && status >= 400) || callbackType === "error" || callbackType === "failed";

    if (isError) {
      console.error(`Stems callback failed for beat ${beatId}:`, JSON.stringify(payload).slice(0, 500));
      await supabase.from("beats").update({ stems_status: "failed" }).eq("id", beatId);
      return new Response(
        JSON.stringify({ ok: true, message: "Stem splitting failed, status updated" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Extract stem tracks array — try multiple keys
    let stemTracks = outerData.data || outerData.output || outerData.tracks || outerData.stems || [];
    // Also check top-level payload keys if nested didn't work
    if (!Array.isArray(stemTracks) || stemTracks.length === 0) {
      stemTracks = payload.output || payload.tracks || payload.stems || [];
    }
    console.log(`Stems callback: found ${Array.isArray(stemTracks) ? stemTracks.length : 0} stem tracks, keys in outerData: ${Object.keys(outerData).join(",")}`);

    if (!Array.isArray(stemTracks) || stemTracks.length === 0) {
      console.error(`Stems callback: no stem tracks in payload for beat ${beatId}. outerData keys: ${Object.keys(outerData).join(",")}, payload keys: ${Object.keys(payload).join(",")}`);
      await supabase.from("beats").update({ stems_status: "failed" }).eq("id", beatId);
      return new Response(
        JSON.stringify({ ok: true, message: "No stem data found" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build stems JSONB object: { "vocals": "url", "drums": "url", ... }
    const stems: Record<string, string> = {};
    for (const stem of stemTracks) {
      const stemType = stem.type || stem.stem_type || stem.name || stem.label || "unknown";
      const stemUrl = stem.audioUrl || stem.audio_url || stem.url || null;
      if (stemType && stemUrl) {
        // Normalize type to lowercase, replace spaces with underscores
        const key = String(stemType).toLowerCase().replace(/\s+/g, "_");
        stems[key] = stemUrl;
      }
    }

    if (Object.keys(stems).length === 0) {
      console.error(`Stems callback: could not extract any stem URLs for beat ${beatId}`);
      await supabase.from("beats").update({ stems_status: "failed" }).eq("id", beatId);
      return new Response(
        JSON.stringify({ ok: true, message: "Could not extract stem URLs" }),
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

    return new Response(
      JSON.stringify({ success: true, beat_id: beatId, stem_count: Object.keys(stems).length }),
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
