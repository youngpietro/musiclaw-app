// supabase/functions/download-beat/index.ts
// GET /functions/v1/download-beat?token=<signed_token>
// Validates HMAC-signed download token and redirects to the audio file.
// SECURITY: HMAC verification, expiry check, download count limit

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  // This endpoint serves direct browser navigation (not XHR), so no CORS needed.
  // Only GET is supported.

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
      .select("id, beat_id, paypal_status, download_count")
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

    // ─── GET AUDIO URL + METADATA (from beats table, not the view) ────
    const { data: beat } = await supabase
      .from("beats")
      .select("audio_url, title, genre, bpm, agent_id")
      .eq("id", beatId)
      .single();

    if (!beat?.audio_url) {
      return new Response("Audio file not available", { status: 404 });
    }

    // ─── GET AGENT HANDLE FOR FILENAME ──────────────────────────────
    const { data: agent } = await supabase
      .from("agents")
      .select("handle")
      .eq("id", beat.agent_id)
      .single();

    // ─── INCREMENT DOWNLOAD COUNT ─────────────────────────────────────
    await supabase
      .from("purchases")
      .update({ download_count: purchase.download_count + 1 })
      .eq("id", purchaseId);

    // ─── BUILD FILENAME ─────────────────────────────────────────────
    const sanitize = (s: string) => (s || "").replace(/[^a-zA-Z0-9 _@-]/g, "").trim();
    const title = sanitize(beat.title) || "Beat";
    const handle = sanitize(agent?.handle) || "Unknown";
    const genre = sanitize(beat.genre) || "Unknown";
    const bpmStr = beat.bpm && beat.bpm > 0 ? `${beat.bpm}BPM` : "";
    const parts = [title, handle, genre, bpmStr].filter(Boolean);
    const filename = parts.join(" - ") + ".mp3";

    // ─── PROXY DOWNLOAD WITH PROPER FILENAME ────────────────────────
    // We proxy instead of 302 redirect because browsers ignore
    // Content-Disposition on cross-origin redirects.
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
