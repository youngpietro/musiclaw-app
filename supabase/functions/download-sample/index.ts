// supabase/functions/download-sample/index.ts
// GET /functions/v1/download-sample?token=<signed_token>
// Validates HMAC-signed download token and proxy-streams sample audio.
// SECURITY: HMAC verification, expiry check, download count limit (5), SSRF prevention

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── SSRF PREVENTION ──────────────────────────────────────────────────
function isAllowedAudioUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "[::1]") return false;
    if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return false;
    if (h.startsWith("10.") || h.startsWith("192.168.")) return false;
    if (h.startsWith("172.")) {
      const second = parseInt(h.split(".")[1], 10);
      if (second >= 16 && second <= 31) return false;
    }
    if (h.startsWith("169.254.")) return false;
    if (h === "metadata.google.internal" || h === "169.254.169.254") return false;
    return true;
  } catch {
    return false;
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

async function hmacVerify(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  let b64 = signature.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const sigBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(payload));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const signingSecret = Deno.env.get("DOWNLOAD_SIGNING_SECRET");
    if (!signingSecret) {
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── EXTRACT AND VERIFY TOKEN ────────────────────────────────────
    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return new Response(
        JSON.stringify({ error: "Download token required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const dotIndex = token.lastIndexOf(".");
    if (dotIndex === -1) {
      return new Response(
        JSON.stringify({ error: "Invalid token format" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const encodedPayload = token.slice(0, dotIndex);
    const signature = token.slice(dotIndex + 1);

    // Decode base64url payload
    let b64 = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const payload = atob(b64);

    // Verify HMAC
    const valid = await hmacVerify(payload, signature, signingSecret);
    if (!valid) {
      return new Response(
        JSON.stringify({ error: "Invalid download token" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse payload: "sample:{sample_id}:{user_id}:{expiresAt}"
    const parts = payload.split(":");
    if (parts.length < 4 || parts[0] !== "sample") {
      return new Response(
        JSON.stringify({ error: "Invalid token payload" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const sampleId = parts[1];
    const userId = parts[2];
    const expiresAt = parts.slice(3).join(":"); // ISO string may contain colons

    // Check expiry
    if (new Date(expiresAt) < new Date()) {
      return new Response(
        JSON.stringify({ error: "Download link has expired" }),
        { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP PURCHASE ────────────────────────────────────────────
    const { data: purchase } = await supabase
      .from("sample_purchases")
      .select("id, sample_id, user_id, download_count")
      .eq("sample_id", sampleId)
      .eq("user_id", userId)
      .single();

    if (!purchase) {
      return new Response(
        JSON.stringify({ error: "Purchase not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (purchase.download_count >= 5) {
      return new Response(
        JSON.stringify({ error: "Maximum downloads reached (5)" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP SAMPLE + BEAT INFO ─────────────────────────────────
    const { data: sample } = await supabase
      .from("samples")
      .select("id, beat_id, stem_type, audio_url")
      .eq("id", sampleId)
      .single();

    if (!sample) {
      return new Response(
        JSON.stringify({ error: "Sample not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: beat } = await supabase
      .from("beats")
      .select("title, genre, bpm")
      .eq("id", sample.beat_id)
      .single();

    // ─── VALIDATE AND FETCH AUDIO ────────────────────────────────────
    if (!isAllowedAudioUrl(sample.audio_url)) {
      console.error(`SSRF blocked: ${sample.audio_url}`);
      return new Response(
        JSON.stringify({ error: "Audio URL security check failed" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Increment download count
    await supabase
      .from("sample_purchases")
      .update({ download_count: purchase.download_count + 1 })
      .eq("id", purchase.id);

    // Build filename
    const title = beat?.title || "Sample";
    const stemLabel = sample.stem_type.charAt(0).toUpperCase() + sample.stem_type.slice(1);
    const bpmStr = beat?.bpm ? ` - ${beat.bpm}BPM` : "";
    const filename = `${title} - ${stemLabel}${bpmStr}.mp3`
      .replace(/[^a-zA-Z0-9\s\-_.]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // Proxy-stream the audio
    const audioRes = await fetch(sample.audio_url);
    if (!audioRes.ok) {
      return new Response(
        JSON.stringify({ error: "Audio file unavailable" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(audioRes.body, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        ...corsHeaders,
      },
    });
  } catch (err) {
    console.error("Download sample error:", err.message);
    return new Response(
      JSON.stringify({ error: "Download failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
