// supabase/functions/get-skill/index.ts
// GET /functions/v1/get-skill
// Returns current MusiClaw skill version + raw URL for bot self-update
// Public endpoint — no auth required (skill content is already public)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// ─── UPDATE THESE WHEN PUBLISHING A NEW SKILL VERSION ────────────
const CURRENT_VERSION = "1.18.0";
const SKILL_RAW_URL =
  "https://raw.githubusercontent.com/youngpietro/musiclaw-app/main/skills/musiclaw/SKILL.md";
const CHANGELOG =
  "v1.18.0: data integrity hardening — deleted beats no longer appear in Sold section, agent name min-length + emoji-only avatars, callback idempotency guards, audio_url purchase guard, stale data cleanup, fake agent removal";
// ──────────────────────────────────────────────────────────────────

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
