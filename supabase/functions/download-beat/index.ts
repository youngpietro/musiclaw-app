// supabase/functions/download-beat/index.ts
// GET /functions/v1/download-beat?token=<signed_token>
// Validates HMAC-signed download token and serves download.
// Track tier: 302 redirect to WAV file (too large to proxy)
// Stems tier: returns JSON with WAV + all stem redirect URLs
// Fallback: if WAV not ready, redirects to MP3
// SECURITY: HMAC verification, expiry check, download count limit

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

  // Decode base64url signature
  let b64 = signature.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const sigBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  return await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(payload));
}

// Re-trigger WAV conversion for expired/missing WAV URLs
async function retriggerWav(beatId: string, sunoId: string, supabase: any): Promise<void> {
  const platformKey = Deno.env.get("PLATFORM_SUNO_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const callbackSecret = Deno.env.get("SUNO_CALLBACK_SECRET");
  if (!platformKey || !callbackSecret) return;

  const wavTaskId = `wav-retrigger-${beatId}-${Date.now()}`;
  try {
    await fetch("https://api.kie.ai/api/v1/wav/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${platformKey}`,
      },
      body: JSON.stringify({
        taskId: wavTaskId,
        audioId: sunoId,
        callBackUrl: `${supabaseUrl}/functions/v1/wav-callback?secret=${callbackSecret}&beat_id=${beatId}`,
      }),
    });
    await supabase.from("beats").update({ wav_status: "processing" }).eq("id", beatId);
    console.log(`WAV re-triggered for beat ${beatId}`);
  } catch (err) {
    console.error(`WAV re-trigger failed for beat ${beatId}:`, err.message);
  }
}

// Re-trigger stems splitting for expired/missing stem URLs
async function retriggerStems(beatId: string, sunoId: string, supabase: any): Promise<void> {
  const platformKey = Deno.env.get("PLATFORM_SUNO_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const callbackSecret = Deno.env.get("SUNO_CALLBACK_SECRET");
  if (!platformKey || !callbackSecret) return;

  const stemsTaskId = `stems-retrigger-${beatId}-${Date.now()}`;
  try {
    await fetch("https://api.sunoapi.org/api/v1/vocal-removal/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${platformKey}`,
      },
      body: JSON.stringify({
        taskId: stemsTaskId,
        audioId: sunoId,
        type: "split_stem",
        callBackUrl: `${supabaseUrl}/functions/v1/stems-callback?secret=${callbackSecret}&beat_id=${beatId}`,
      }),
    });
    await supabase.from("beats").update({ stems_status: "processing" }).eq("id", beatId);
    console.log(`Stems re-triggered for beat ${beatId}`);
  } catch (err) {
    console.error(`Stems re-trigger failed for beat ${beatId}:`, err.message);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const signingSecret = Deno.env.get("DOWNLOAD_SIGNING_SECRET");
    if (!signingSecret) {
      return new Response("Server configuration error", { status: 500 });
    }

    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return new Response("Missing download token", { status: 400 });
    }

    // ─── PARSE TOKEN ──────────────────────────────────────────────────
    const dotIndex = token.lastIndexOf(".");
    if (dotIndex === -1) {
      return new Response("Invalid token format", { status: 403 });
    }

    const encodedPayload = token.substring(0, dotIndex);
    const signature = token.substring(dotIndex + 1);

    // Decode base64url payload
    let b64Payload = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    while (b64Payload.length % 4) b64Payload += "=";
    let payload: string;
    try {
      payload = atob(b64Payload);
    } catch {
      return new Response("Invalid token encoding", { status: 403 });
    }

    // ─── VERIFY HMAC SIGNATURE ────────────────────────────────────────
    const valid = await hmacVerify(payload, signature, signingSecret);
    if (!valid) {
      return new Response("Invalid or tampered token", { status: 403 });
    }

    // ─── PARSE PAYLOAD ────────────────────────────────────────────────
    const parts = payload.split(":");
    if (parts.length < 3) {
      return new Response("Invalid token payload", { status: 403 });
    }

    const purchaseId = parts[0];
    const beatId = parts[1];
    const expiresAt = parts.slice(2).join(":"); // ISO date may contain colons

    // ─── CHECK EXPIRY ─────────────────────────────────────────────────
    const expiryDate = new Date(expiresAt);
    if (isNaN(expiryDate.getTime()) || expiryDate < new Date()) {
      return new Response("Download link has expired", { status: 410 });
    }

    // ─── VERIFY PURCHASE IN DB ────────────────────────────────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: purchase } = await supabase
      .from("purchases")
      .select("id, beat_id, paypal_status, download_count, purchase_tier")
      .eq("id", purchaseId)
      .single();

    if (!purchase) {
      return new Response("Purchase not found", { status: 404 });
    }

    if (purchase.paypal_status !== "completed") {
      return new Response("Payment not completed", { status: 403 });
    }

    if (purchase.beat_id !== beatId) {
      return new Response("Token mismatch", { status: 403 });
    }

    // ─── CHECK DOWNLOAD LIMIT ─────────────────────────────────────────
    const MAX_DOWNLOADS = 5;
    if (purchase.download_count >= MAX_DOWNLOADS) {
      return new Response(
        "Download limit reached (max 5 downloads per purchase)",
        { status: 429 }
      );
    }

    const tier = purchase.purchase_tier || "track";

    // ─── GET BEAT DATA ────────────────────────────────────────────────
    const { data: beat } = await supabase
      .from("beats")
      .select("audio_url, wav_url, wav_status, stems, stems_status, suno_id, title, genre, bpm, agent_id")
      .eq("id", beatId)
      .single();

    if (!beat) {
      return new Response("Beat not found", { status: 404 });
    }

    // ─── GET AGENT HANDLE FOR FILENAME ────────────────────────────────
    const { data: agent } = await supabase
      .from("agents")
      .select("handle")
      .eq("id", beat.agent_id)
      .single();

    // ─── BUILD FILENAME PARTS ─────────────────────────────────────────
    const sanitize = (s: string) => (s || "").replace(/[^a-zA-Z0-9 _@-]/g, "").trim();
    const title = sanitize(beat.title) || "Beat";
    const handle = sanitize(agent?.handle) || "Unknown";
    const genre = sanitize(beat.genre) || "Unknown";
    const bpmStr = beat.bpm && beat.bpm > 0 ? `${beat.bpm}BPM` : "";
    const nameParts = [title, handle, genre, bpmStr].filter(Boolean);

    // ─── INCREMENT DOWNLOAD COUNT ─────────────────────────────────────
    await supabase
      .from("purchases")
      .update({ download_count: purchase.download_count + 1 })
      .eq("id", purchaseId);

    // ═══════════════════════════════════════════════════════════════════
    //  STEMS TIER: Return JSON with all download URLs
    // ═══════════════════════════════════════════════════════════════════
    if (tier === "stems") {
      // Check if stems are available
      if (beat.stems_status !== "complete" || !beat.stems) {
        // Try re-triggering if we have a suno_id
        if (beat.suno_id && beat.stems_status !== "processing") {
          await retriggerStems(beatId, beat.suno_id, supabase);
        }

        // Also check WAV
        if (beat.suno_id && beat.wav_status !== "complete" && beat.wav_status !== "processing") {
          await retriggerWav(beatId, beat.suno_id, supabase);
        }

        // Undo download count increment (not a real download yet)
        await supabase
          .from("purchases")
          .update({ download_count: purchase.download_count })
          .eq("id", purchaseId);

        return new Response(
          JSON.stringify({
            status: "processing",
            message: "Stems are being prepared. Please retry in about 60 seconds.",
            retry_after: 60,
          }),
          { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Determine WAV URL (fallback to MP3)
      let wavDownloadUrl = beat.wav_url;
      if (!wavDownloadUrl) {
        // WAV not available — try re-triggering
        if (beat.suno_id && beat.wav_status !== "processing") {
          await retriggerWav(beatId, beat.suno_id, supabase);
        }
        // Fall back to MP3 for the main track
        wavDownloadUrl = beat.audio_url;
      }

      // Build stems download data
      const stemsData: Record<string, string> = {};
      if (beat.stems && typeof beat.stems === "object") {
        for (const [stemType, stemUrl] of Object.entries(beat.stems)) {
          if (stemUrl && typeof stemUrl === "string") {
            stemsData[stemType] = stemUrl as string;
          }
        }
      }

      return new Response(
        JSON.stringify({
          status: "ready",
          tier: "stems",
          track: {
            url: wavDownloadUrl,
            filename: nameParts.join(" - ") + (beat.wav_url ? ".wav" : ".mp3"),
            format: beat.wav_url ? "wav" : "mp3",
          },
          stems: stemsData,
          beat_title: beat.title,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ═══════════════════════════════════════════════════════════════════
    //  TRACK TIER: Redirect to WAV file (or fallback to MP3 proxy)
    // ═══════════════════════════════════════════════════════════════════

    // Prefer WAV, fallback to MP3
    if (beat.wav_url && beat.wav_status === "complete") {
      // WAV available — 302 redirect (WAV files are ~30MB, too large to proxy)
      const wavFilename = nameParts.join(" - ") + ".wav";
      return new Response(null, {
        status: 302,
        headers: {
          "Location": beat.wav_url,
          "Content-Disposition": `attachment; filename="${wavFilename}"`,
          "Cache-Control": "no-store, no-cache",
        },
      });
    }

    // WAV not ready — try re-triggering if possible
    if (beat.suno_id && beat.wav_status !== "processing") {
      await retriggerWav(beatId, beat.suno_id, supabase);
    }

    // Fallback: proxy MP3 (small enough to proxy, ~3-5MB)
    if (!beat.audio_url) {
      return new Response("Audio file not available", { status: 404 });
    }

    const filename = nameParts.join(" - ") + ".mp3";
    const audioRes = await fetch(beat.audio_url);
    if (!audioRes.ok || !audioRes.body) {
      return new Response("Failed to fetch audio file", { status: 502 });
    }

    return new Response(audioRes.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store, no-cache",
      },
    });
  } catch (err) {
    console.error("Download error:", err.message);
    return new Response("Download failed", { status: 500 });
  }
});
