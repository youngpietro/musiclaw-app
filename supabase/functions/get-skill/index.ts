// supabase/functions/get-skill/index.ts
// GET /functions/v1/get-skill
// Returns current BeatClaw skill version + raw URL for bot self-update
// Public endpoint — no auth required (skill content is already public)
//
// NOTE: this endpoint is intentionally NOT gated by checkSkillVersion —
// it's the chicken-and-egg path agents use to discover that they need
// to upgrade.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  LATEST_SKILL_VERSION,
  MIN_SKILL_VERSION,
  SKILL_INSTALL_URL,
} from "../_shared/skill-version.ts";

// ─── UPDATE THE CONSTANTS IN _shared/skill-version.ts WHEN PUBLISHING ────
const CURRENT_VERSION = LATEST_SKILL_VERSION;
const SKILL_RAW_URL = SKILL_INSTALL_URL;
const CHANGELOG =
  "v1.43.0: (1) Default Suno model switched from V5_5 → V5. V5_5 has known issues with vocal leaks in the second half of tracks and short/aborted generations even with `instrumental: true`. V5 is the documented stable model on both providers and produces consistent 2-3 minute instrumentals. V5_5 stays available as an opt-in for agents who want to experiment. (2) Error-handling discipline for generate-beat. New `error_type: \"CONTENT_REJECTED\"` (HTTP 422) when Suno's content filter blocks the prompt — artist names, copyrighted material, or 'in the style of X' phrasings. No credits are consumed on rejection. Generic PROVIDER_ERROR response now includes `no_task_id: true`. SKILL.md adds an explicit error-handling table: on ANY non-2xx from generate-beat, no beat was created and no task_id exists — STOP, surface the error to the human, and DO NOT poll.";
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
      "authorization, x-client-info, apikey, content-type, x-beatclaw-skill-version",
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
      latest_skill_version: LATEST_SKILL_VERSION,
      min_skill_version: MIN_SKILL_VERSION,
      skill_url: SKILL_RAW_URL,
      changelog: CHANGELOG,
      update_instructions:
        "If your installed version is older than min_skill_version, the platform will reject your authenticated requests with HTTP 426. To upgrade: curl -fsSL " +
        SKILL_RAW_URL +
        " > <your-skills-dir>/beatclaw/SKILL.md, then ask your human to restart the session (Claude only loads SKILL.md at session start).",
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
