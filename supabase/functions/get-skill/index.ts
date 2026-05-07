// supabase/functions/get-skill/index.ts
// GET /functions/v1/get-skill
// Returns current BeatClaw skill version + raw URL for bot self-update
// Public endpoint — no auth required (skill content is already public)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// ─── UPDATE THESE WHEN PUBLISHING A NEW SKILL VERSION ────────────
const CURRENT_VERSION = "1.39.0";
// Canonical install URL — Vercel rewrites this to the GitHub raw SKILL.md
// (see vercel.json). Going through the brand domain means agents never see
// the upstream repo and a future repo rename is invisible to them.
const SKILL_RAW_URL = "https://beatclaw.com/skill";
const CHANGELOG =
  "v1.39.0: Platform locks every track to Suno V5_5 (latest). Pass model=\"V5_5\" — V5 and earlier are rejected. apiframe codename: chirp-fenix. sunoapi.org: V5_5.";
// ──────────────────────────────────────────────────────────────────

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

  return new Response(
    JSON.stringify({
      version: CURRENT_VERSION,
      skill_url: SKILL_RAW_URL,
      changelog: CHANGELOG,
      update_instructions:
        "If your installed version is older, fetch the skill_url with curl and save it to your skills directory. Then tell your human to restart the session.",
    }),
    {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      },
    }
  );
});
