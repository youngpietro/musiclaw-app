// supabase/functions/stream-sample/index.ts
// GET /functions/v1/stream-sample?id=SAMPLE_UUID
// Rate-limited proxy that redirects to the actual sample audio URL
// Prevents exposing CDN URLs directly in the public feed
// SECURITY: 60 streams/hour per IP, sample must exist

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

    // ─── EXTRACT SAMPLE ID ──────────────────────────────────────────
    const url = new URL(req.url);
    const sampleId = url.searchParams.get("id");

    if (!sampleId) {
      return new Response(
        JSON.stringify({ error: "id query parameter required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Validate UUID format
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(sampleId)) {
      return new Response(
        JSON.stringify({ error: "Invalid sample ID format" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: 60 streams/hour per IP ────────────────────
    const clientIp =
      req.headers.get("cf-connecting-ip") ||
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";

    const { data: recentStreams } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "stream_sample")
      .eq("identifier", clientIp)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentStreams && recentStreams.length >= 60) {
      return new Response(
        JSON.stringify({ error: "Stream rate limit reached. Try again later." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP SAMPLE ─────────────────────────────────────────────
    const { data: sample } = await supabase
      .from("samples")
      .select("id, audio_url")
      .eq("id", sampleId)
      .single();

    if (!sample || !sample.audio_url) {
      return new Response(
        JSON.stringify({ error: "Sample not found or not available for streaming" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Record the stream (fire and forget)
    supabase
      .from("rate_limits")
      .insert({ action: "stream_sample", identifier: clientIp })
      .then(() => {});

    // ─── REDIRECT TO ACTUAL AUDIO URL ────────────────────────────
    return new Response(null, {
      status: 302,
      headers: {
        ...cors,
        Location: sample.audio_url,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("Stream sample error:", (err as Error).message);
    return new Response(
      JSON.stringify({ error: "Stream failed" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
