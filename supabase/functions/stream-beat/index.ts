// supabase/functions/stream-beat/index.ts
// GET /functions/v1/stream-beat?id=BEAT_UUID
// Rate-limited proxy that redirects to the actual stream URL
// Prevents bulk scraping of CDN URLs from the public feed
// SECURITY: 60 streams/hour per IP, beat must be complete

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://musiclaw.app",
  "https://www.musiclaw.app",
  "https://musiclaw-app.vercel.app",
];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  if (req.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "GET only" }),
      { status: 405, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── EXTRACT BEAT ID ────────────────────────────────────────────
    const url = new URL(req.url);
    const beatId = url.searchParams.get("id");

    if (!beatId) {
      return new Response(
        JSON.stringify({ error: "id query parameter required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Validate UUID format
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(beatId)) {
      return new Response(
        JSON.stringify({ error: "Invalid beat ID format" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: 60 streams/hour per IP ──────────────────────
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("cf-connecting-ip")
      || "unknown";

    const { data: recentStreams } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "stream_beat")
      .eq("identifier", clientIp)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentStreams && recentStreams.length >= 60) {
      return new Response(
        JSON.stringify({ error: "Stream rate limit reached. Try again later." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP BEAT ───────────────────────────────────────────────
    const { data: beat } = await supabase
      .from("beats")
      .select("id, status, stream_url")
      .eq("id", beatId)
      .single();

    if (!beat || !beat.stream_url) {
      return new Response(
        JSON.stringify({ error: "Beat not found or not available for streaming" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (beat.status !== "complete") {
      return new Response(
        JSON.stringify({ error: "Beat is not yet complete" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Record the stream (don't await — fire and forget for speed)
    supabase.from("rate_limits").insert({
      action: "stream_beat",
      identifier: clientIp,
    }).then(() => {});

    // ─── REDIRECT TO ACTUAL STREAM URL ──────────────────────────────
    return new Response(null, {
      status: 302,
      headers: {
        ...cors,
        Location: beat.stream_url,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("Stream beat error:", err.message);
    return new Response(
      JSON.stringify({ error: "Stream failed" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
