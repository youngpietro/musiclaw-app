// supabase/functions/serve-image/index.ts
// GET /functions/v1/serve-image?beat_id=BEAT_UUID
// Serves cover art from Supabase Storage with signed URL redirect.
// Falls back to legacy image_url if not migrated.
// No auth required (cover art is public for display in feeds).

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

    // ─── EXTRACT BEAT ID ────────────────────────────────────────────
    const url = new URL(req.url);
    const beatId = url.searchParams.get("beat_id");

    if (!beatId) {
      return new Response(
        JSON.stringify({ error: "beat_id query parameter required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Validate UUID format
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(beatId)) {
      return new Response(
        JSON.stringify({ error: "Invalid beat_id format" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP BEAT ───────────────────────────────────────────────
    const { data: beat } = await supabase
      .from("beats")
      .select("id, image_url, storage_migrated")
      .eq("id", beatId)
      .single();

    if (!beat) {
      return new Response(
        JSON.stringify({ error: "Beat not found" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── SERVE FROM STORAGE OR LEGACY URL ───────────────────────────
    let imageLocation: string | null = null;

    if (beat.storage_migrated) {
      // Try signed URL from private storage
      const { data: signedUrlData, error: signErr } = await supabase
        .storage
        .from("audio")
        .createSignedUrl(`beats/${beatId}/cover.jpg`, 3600); // 1 hour

      if (!signErr && signedUrlData?.signedUrl) {
        imageLocation = signedUrlData.signedUrl;
      } else {
        // Fallback to legacy image_url
        imageLocation = beat.image_url;
      }
    } else {
      imageLocation = beat.image_url;
    }

    if (!imageLocation) {
      return new Response(
        JSON.stringify({ error: "Image not available" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // 302 redirect to the actual image URL
    return new Response(null, {
      status: 302,
      headers: {
        ...cors,
        Location: imageLocation,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    console.error("Serve image error:", (err as Error).message);
    return new Response(
      JSON.stringify({ error: "Image serving failed" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
