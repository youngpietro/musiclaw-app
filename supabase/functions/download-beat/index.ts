// supabase/functions/download-beat/index.ts
// GET /functions/v1/download-beat?token=<signed_token>
// Validates HMAC-signed download token and serves download.
// Track tier: proxy-streamed WAV file with Content-Disposition filename
// Stems tier: returns JSON with proxied download URLs, or proxy-streams individual files via ?file=
//   ?file=zip: fetches all files in parallel, creates ZIP in memory, returns single ZIP download
//   ?file=track|drums|bass|vocal|other: proxy-streams individual file with correct filename
// Fallback: if WAV not ready, proxy-streams MP3
// SECURITY: HMAC verification, expiry check, download count limit

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import JSZip from "https://esm.sh/jszip@3.10.1";

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
    const fileParam = url.searchParams.get("file"); // e.g., "track", "drums", "bass", "vocal"

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

    // ═══════════════════════════════════════════════════════════════════
    //  STEMS TIER + ?file= : Proxy-stream individual file with filename
    //  (No download count increment — counted on JSON fetch only)
    // ═══════════════════════════════════════════════════════════════════
    if (tier === "stems" && fileParam) {
      // ─── ZIP: Fetch all files in parallel, create ZIP in memory ─────
      if (fileParam === "zip") {
        const filesToZip: Array<{ url: string; filename: string }> = [];

        // Add master track
        const trackUrl = beat.wav_url || beat.audio_url;
        if (trackUrl) {
          filesToZip.push({
            url: trackUrl,
            filename: nameParts.join(" - ") + (beat.wav_url ? ".wav" : ".mp3"),
          });
        }

        // Add all stems
        if (beat.stems && typeof beat.stems === "object") {
          for (const [stemType, stemUrl] of Object.entries(beat.stems)) {
            if (stemUrl && typeof stemUrl === "string") {
              const label = stemType.charAt(0).toUpperCase() + stemType.slice(1);
              filesToZip.push({
                url: stemUrl as string,
                filename: nameParts.join(" - ") + " - " + label + ".mp3",
              });
            }
          }
        }

        if (filesToZip.length === 0) {
          return new Response("No files available for ZIP", { status: 404 });
        }

        // Fetch all files in parallel (fast datacenter-to-datacenter)
        const fetchResults = await Promise.all(
          filesToZip.map(async (f) => {
            const res = await fetch(f.url);
            if (!res.ok) throw new Error(`Failed to fetch ${f.filename}: ${res.status}`);
            return { filename: f.filename, data: new Uint8Array(await res.arrayBuffer()) };
          })
        );

        // Create ZIP (STORE = no compression, audio doesn't compress, saves CPU + memory)
        const zip = new JSZip();
        for (const { filename, data } of fetchResults) {
          zip.file(filename, data);
        }
        const zipData = await zip.generateAsync({ type: "uint8array", compression: "STORE" });

        const zipFilename = (title || "Beat") + " - WAV + Stems.zip";
        return new Response(zipData, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${zipFilename}"`,
            "Cache-Control": "no-store, no-cache",
          },
        });
      }

      // ─── Individual file: proxy-stream with correct filename ────────
      let fileUrl: string | null = null;
      let fileName = "";

      if (fileParam === "track") {
        fileUrl = beat.wav_url || beat.audio_url;
        fileName = nameParts.join(" - ") + (beat.wav_url ? ".wav" : ".mp3");
      } else if (beat.stems && typeof beat.stems === "object" && (beat.stems as Record<string, string>)[fileParam]) {
        fileUrl = (beat.stems as Record<string, string>)[fileParam];
        const label = fileParam.charAt(0).toUpperCase() + fileParam.slice(1);
        fileName = nameParts.join(" - ") + " - " + label + ".mp3";
      }

      if (!fileUrl) {
        return new Response("File not found", { status: 404 });
      }

      // Proxy-stream: fetch from CDN and pipe through with correct filename
      const fileRes = await fetch(fileUrl);
      if (!fileRes.ok || !fileRes.body) {
        return new Response("Failed to fetch file", { status: 502 });
      }
      const isWav = fileName.endsWith(".wav");
      return new Response(fileRes.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": isWav ? "audio/wav" : "audio/mpeg",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Cache-Control": "no-store, no-cache",
        },
      });
    }

    // ─── INCREMENT DOWNLOAD COUNT (only for JSON/track requests) ─────
    await supabase
      .from("purchases")
      .update({ download_count: purchase.download_count + 1 })
      .eq("id", purchaseId);

    // ═══════════════════════════════════════════════════════════════════
    //  STEMS TIER: Return JSON with proxied download URLs
    // ═══════════════════════════════════════════════════════════════════
    if (tier === "stems") {
      // Check if stems are available
      if (beat.stems_status !== "complete" || !beat.stems) {
        // Undo download count increment (not a real download yet)
        await supabase
          .from("purchases")
          .update({ download_count: purchase.download_count })
          .eq("id", purchaseId);

        const isProcessing = beat.stems_status === "processing" || beat.wav_status === "processing";
        return new Response(
          JSON.stringify({
            status: isProcessing ? "processing" : "unavailable",
            message: isProcessing
              ? "Stems are being prepared. Please retry in about 60 seconds."
              : "Stems are not yet available for this beat. Please contact the seller.",
            retry_after: isProcessing ? 60 : null,
          }),
          { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Build proxied URLs that go through this same endpoint with ?file= param
      // This avoids CORS issues (browser downloads from our domain, we redirect to CDN)
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const baseUrl = `${supabaseUrl}/functions/v1/download-beat?token=${encodeURIComponent(token)}`;

      // Build stems download data with proxied URLs and proper filenames
      const stemsData: Record<string, { url: string; filename: string }> = {};
      if (beat.stems && typeof beat.stems === "object") {
        for (const [stemType, stemUrl] of Object.entries(beat.stems)) {
          if (stemUrl && typeof stemUrl === "string") {
            const stemLabel = stemType.charAt(0).toUpperCase() + stemType.slice(1);
            stemsData[stemType] = {
              url: `${baseUrl}&file=${encodeURIComponent(stemType)}`,
              filename: nameParts.join(" - ") + " - " + stemLabel + ".mp3",
            };
          }
        }
      }

      return new Response(
        JSON.stringify({
          status: "ready",
          tier: "stems",
          zipUrl: `${baseUrl}&file=zip`,
          track: {
            url: `${baseUrl}&file=track`,
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
      // Proxy-stream WAV through our endpoint for correct filename
      const wavFilename = nameParts.join(" - ") + ".wav";
      const wavRes = await fetch(beat.wav_url);
      if (!wavRes.ok || !wavRes.body) {
        return new Response("Failed to fetch WAV file", { status: 502 });
      }
      return new Response(wavRes.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "audio/wav",
          "Content-Disposition": `attachment; filename="${wavFilename}"`,
          "Cache-Control": "no-store, no-cache",
        },
      });
    }

    // WAV not ready — fallback to MP3
    // (Agent must call process-stems to trigger WAV conversion)
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
        ...corsHeaders,
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
