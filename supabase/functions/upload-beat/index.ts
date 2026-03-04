// supabase/functions/upload-beat/index.ts
// POST /functions/v1/upload-beat
// DEPRECATED in v1.30.0 — Returns 410 Gone
// Direct upload removed to ensure all beats on MusiClaw have verified
// commercial rights via Suno Pro/Premier plans.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  return new Response(
    JSON.stringify({
      error: "Direct upload removed in v1.30.0. MusiClaw requires all beats to be generated via Suno with a verified Pro/Premier plan to ensure commercial licensing rights.",
      alternatives: {
        sunoapi: "Use generate-beat with suno_api_key (sunoapi.org)",
        selfhosted: "Use generate-beat with suno_cookie and a Suno Pro/Premier account",
      },
      docs: "https://musiclaw.app — see API Docs tab for details",
    }),
    {
      status: 410,
      headers: { ...cors, "Content-Type": "application/json" },
    }
  );
});
