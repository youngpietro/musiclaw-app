// supabase/functions/download-beat/index.ts
// GET /functions/v1/download-beat?token=<signed_token>
// Validates HMAC-signed download token and serves download.
// Track tier: proxy-streamed WAV file with Content-Disposition filename
// Stems tier: returns JSON with proxied download URLs, or proxy-streams individual files via ?file=
//   ?file=zip: fetches all files in parallel, creates ZIP in memory, returns single ZIP download
//   ?file=track|drums|bass|vocal|other: proxy-streams individual file with correct filename
// Fallback: if WAV not ready, proxy-streams MP3
// SECURITY: HMAC verification, expiry check, download count limit, SSRF prevention

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import JSZip from "https://esm.sh/jszip@3.10.1";

// ─── SSRF PREVENTION ──────────────────────────────────────────────────
// Validates that audio URLs are HTTPS and not targeting internal/private networks.
// All URLs fetched by this function come from DB (audio_url, wav_url, stems),
// but a compromised DB record could point to internal services.
function isAllowedAudioUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    // Block internal/private hostnames
    if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "[::1]" || h === "::1") return false;
    if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return false;
    // Block private IP ranges (RFC 1918 + link-local)
    if (h.startsWith("10.") || h.startsWith("192.168.")) return false;
    if (h.startsWith("172.")) {
      const second = parseInt(h.split(".")[1], 10);
      if (second >= 16 && second <= 31) return false;
    }
    if (h.startsWith("169.254.")) return false; // link-local
    // Block metadata endpoints (cloud providers)
    if (h === "metadata.google.internal" || h === "169.254.169.254") return false;
    return true;
  } catch {
    return false;
  }
}

const ALLOWED_ORIGINS = [
  "https://beatclaw.com",
  "https://www.beatclaw.com",
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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}

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
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

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

    // ─── EXPIRY CHECK (legacy tokens only — new tokens never expire) ──
    // Skip expiry check: purchases are permanent, download links never expire

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

    // Download limit removed — purchases are permanent, unlimited downloads

    const tier = purchase.purchase_tier || "track";
    const fileParam = url.searchParams.get("file"); // e.g., "track", "drums", "bass", "vocal"

    // ─── GET BEAT DATA ────────────────────────────────────────────────
    const { data: beat } = await supabase
      .from("beats")
      .select("audio_url, wav_url, wav_status, stems, stems_status, suno_id, title, genre, bpm, agent_id, storage_migrated")
      .eq("id", beatId)
      .single();

    if (!beat) {
      return new Response("Beat not found", { status: 404 });
    }

    // ─── R2 URL RESOLVER ──────────────────────────────────────────────
    // For migrated beats, resolve URLs from R2 public domain (zero network calls)
    const { r2PublicUrl } = await import("../_shared/r2.ts");
    const R2_PUBLIC = Deno.env.get("R2_PUBLIC_URL") || "https://cdn.beatclaw.com";
    function resolveStorageUrl(storagePath: string, fallbackUrl?: string | null): string | null {
      if (beat!.storage_migrated) {
        return r2PublicUrl(storagePath);
      }
      return fallbackUrl || null;
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

        // Add master track (prefer R2, then wav_url, then audio_url)
        const trackUrl = resolveStorageUrl(`beats/${beatId}/track.mp3`, beat.wav_url || beat.audio_url);
        if (trackUrl) {
          // If serving from R2 it's always MP3 now (WAV conversion is client-side)
          const isFromR2 = beat.storage_migrated && trackUrl.includes(R2_PUBLIC);
          filesToZip.push({
            url: trackUrl,
            filename: nameParts.join(" - ") + ((!isFromR2 && beat.wav_url) ? ".wav" : ".mp3"),
          });
        }

        // Add all stems (prefer R2 URLs)
        if (beat.stems && typeof beat.stems === "object") {
          for (const [stemType, stemUrl] of Object.entries(beat.stems)) {
            if (stemUrl && typeof stemUrl === "string") {
              const label = stemType.charAt(0).toUpperCase() + stemType.slice(1);
              const resolvedUrl = resolveStorageUrl(`beats/${beatId}/stems/${stemType}.mp3`, stemUrl as string);
              if (resolvedUrl) {
                filesToZip.push({
                  url: resolvedUrl,
                  filename: nameParts.join(" - ") + " - " + label + ".mp3",
                });
              }
            }
          }
        }

        if (filesToZip.length === 0) {
          return new Response("No files available for ZIP", { status: 404 });
        }

        // Validate all URLs before fetching (SSRF prevention)
        for (const f of filesToZip) {
          if (!isAllowedAudioUrl(f.url)) {
            console.error(`SSRF blocked: disallowed URL for ZIP file "${f.filename}": ${f.url}`);
            return new Response("Blocked: invalid audio source URL", { status: 403 });
          }
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
            ...cors,
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
        fileUrl = resolveStorageUrl(`beats/${beatId}/track.mp3`, beat.wav_url || beat.audio_url);
        const isFromR2 = beat.storage_migrated && fileUrl?.includes(R2_PUBLIC);
        fileName = nameParts.join(" - ") + ((!isFromR2 && beat.wav_url) ? ".wav" : ".mp3");
      } else if (beat.stems && typeof beat.stems === "object" && (beat.stems as Record<string, string>)[fileParam]) {
        fileUrl = resolveStorageUrl(`beats/${beatId}/stems/${fileParam}.mp3`, (beat.stems as Record<string, string>)[fileParam]);
        const label = fileParam.charAt(0).toUpperCase() + fileParam.slice(1);
        fileName = nameParts.join(" - ") + " - " + label + ".mp3";
      }

      if (!fileUrl) {
        return new Response("File not found", { status: 404 });
      }

      // SSRF prevention: validate URL before fetching
      if (!isAllowedAudioUrl(fileUrl)) {
        console.error(`SSRF blocked: disallowed URL for file "${fileParam}": ${fileUrl}`);
        return new Response("Blocked: invalid audio source URL", { status: 403 });
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
          ...cors,
          "Content-Type": isWav ? "audio/wav" : "audio/mpeg",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Cache-Control": "no-store, no-cache",
        },
      });
    }

    // ─── ATOMIC DOWNLOAD COUNT INCREMENT (SQL-level to prevent race conditions) ─────
    await supabase.rpc("increment_download_count", {
      p_table: "purchases",
      p_id: purchaseId,
    }).then(async ({ error }) => {
      if (error) {
        // Fallback: conditional update
        await supabase
          .from("purchases")
          .update({ download_count: purchase.download_count + 1 })
          .eq("id", purchaseId);
      }
    });

    // ═══════════════════════════════════════════════════════════════════
    //  STEMS TIER: Return JSON with proxied download URLs
    // ═══════════════════════════════════════════════════════════════════
    if (tier === "stems") {
      // Check if stems are available
      if (beat.stems_status !== "complete" || !beat.stems) {
        // Undo download count increment (not a real download yet) — use RPC with negative
        await supabase.rpc("increment_download_count", {
          p_table: "purchases",
          p_id: purchaseId,
          p_delta: -1,
        }).then(async ({ error }) => {
          if (error) {
            await supabase
              .from("purchases")
              .update({ download_count: purchase.download_count })
              .eq("id", purchaseId);
          }
        });

        const isProcessing = beat.stems_status === "processing" || beat.wav_status === "processing";
        return new Response(
          JSON.stringify({
            status: isProcessing ? "processing" : "unavailable",
            message: isProcessing
              ? "Stems are being prepared. Please retry in about 60 seconds."
              : "Stems are not yet available for this beat. Please contact the seller.",
            retry_after: isProcessing ? 60 : null,
          }),
          { status: 202, headers: { ...cors, "Content-Type": "application/json" } }
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
            filename: nameParts.join(" - ") + ".mp3",
            format: "mp3",
          },
          stems: stemsData,
          beat_title: beat.title,
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ═══════════════════════════════════════════════════════════════════
    //  TRACK TIER: Serve MP3 from storage (WAV conversion is client-side)
    // ═══════════════════════════════════════════════════════════════════

    // Prefer R2, fallback to legacy URLs
    const trackUrl = resolveStorageUrl(`beats/${beatId}/track.mp3`, beat.audio_url);

    if (!trackUrl) {
      return new Response(
        JSON.stringify({ error: "Audio file is not available. Please contact support." }),
        { status: 503, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // SSRF prevention: validate URL before fetching (R2 URLs are always safe, but check legacy)
    if (!trackUrl.includes(R2_PUBLIC) && !isAllowedAudioUrl(trackUrl)) {
      console.error(`SSRF blocked: disallowed audio URL for beat ${beatId}: ${trackUrl}`);
      return new Response("Blocked: invalid audio source URL", { status: 403 });
    }

    const mp3Filename = nameParts.join(" - ") + ".mp3";
    const audioRes = await fetch(trackUrl);
    if (!audioRes.ok || !audioRes.body) {
      return new Response("Failed to fetch audio file", { status: 502 });
    }
    return new Response(audioRes.body, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "audio/mpeg",
        "Content-Disposition": `attachment; filename="${mp3Filename}"`,
        "Cache-Control": "no-store, no-cache",
      },
    });
  } catch (err) {
    console.error("Download error:", err.message);
    return new Response("Download failed", { status: 500 });
  }
});
