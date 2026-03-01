// supabase/functions/wav-callback/index.ts
// POST /functions/v1/wav-callback
// Receives callbacks from Suno WAV conversion API (api.sunoapi.org)
// Updates the beat record with the WAV download URL
// SECURITY: Required secret validation via query param

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
    // Check header first (preferred), fall back to query param (legacy)
    const providedSecret = req.headers.get("x-callback-secret") || url.searchParams.get("secret") || "";
    if (providedSecret !== expectedSecret) {
      console.warn("WAV callback: invalid secret");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── EXTRACT BEAT ID FROM QUERY ─────────────────────────────────
    const beatId = url.searchParams.get("beat_id");
    if (!beatId) {
      console.error("WAV callback: missing beat_id query param");
      return new Response(
        JSON.stringify({ error: "beat_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── IDEMPOTENCY: skip if beat is sold, deleted, or WAV already done ─
    const { data: beatCheck } = await supabase
      .from("beats")
      .select("id, sold, deleted_at, wav_status")
      .eq("id", beatId)
      .single();

    if (!beatCheck) {
      console.warn(`WAV callback: beat ${beatId} not found`);
      return new Response(
        JSON.stringify({ ok: true, message: "Beat not found" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (beatCheck.sold || beatCheck.deleted_at) {
      console.log(`WAV callback: beat ${beatId} is ${beatCheck.sold ? "sold" : "deleted"} — skipping`);
      return new Response(
        JSON.stringify({ ok: true, message: "Beat already finalized" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (beatCheck.wav_status === "complete") {
      console.log(`WAV callback: beat ${beatId} WAV already complete — skipping`);
      return new Response(
        JSON.stringify({ ok: true, message: "WAV already complete" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── PARSE CALLBACK PAYLOAD ─────────────────────────────────────
    const payload = await req.json();
    console.log(`WAV callback for beat ${beatId}:`, JSON.stringify(payload).slice(0, 1000));

    // API response format: { code: 200, data: { audioWavUrl: "...", task_id: "..." } }
    // or error: { code: 4xx/5xx, ... }
    const data = payload.data || payload;
    const wavUrl = data.audioWavUrl || data.audio_wav_url || data.wav_url || null;
    const status = payload.code || payload.status;
    const callbackType = data.callbackType || data.callback_type || payload.callbackType || "";

    // Check for error/failure
    const isError = (status && status >= 400) || callbackType === "error" || callbackType === "failed";

    if (isError || !wavUrl) {
      console.error(`WAV callback failed for beat ${beatId}:`, JSON.stringify(payload).slice(0, 500));
      await supabase.from("beats").update({ wav_status: "failed" }).eq("id", beatId);
      return new Response(
        JSON.stringify({ ok: true, message: "WAV conversion failed, status updated" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── VALIDATE WAV URL FORMAT ─────────────────────────────────────
    let isValidUrl = false;
    try {
      const parsed = new URL(wavUrl);
      isValidUrl = parsed.protocol === "https:";
    } catch { isValidUrl = false; }

    if (!isValidUrl) {
      console.error(`WAV callback: invalid URL format for beat ${beatId}: ${String(wavUrl).slice(0, 100)}`);
      await supabase.from("beats").update({ wav_status: "failed" }).eq("id", beatId);
      return new Response(
        JSON.stringify({ ok: true, message: "Invalid WAV URL format" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── UPDATE BEAT WITH WAV URL ───────────────────────────────────
    const { error: updateErr } = await supabase
      .from("beats")
      .update({ wav_url: wavUrl, wav_status: "complete" })
      .eq("id", beatId);

    if (updateErr) throw updateErr;

    console.log(`Beat ${beatId} WAV complete: ${wavUrl.slice(0, 80)}...`);

    return new Response(
      JSON.stringify({ success: true, beat_id: beatId }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("WAV callback error:", err.message);
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
