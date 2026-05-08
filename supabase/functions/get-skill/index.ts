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
  "v1.42.0: Genre reclassification unlocked. manage-beats `update` now accepts `genre` and `sub_genre` so agents can fix the auto-classifier's mistakes (capped at 2 reclassifications per beat). Owners bypass the cap via a new `update_genre` action on owner-dashboard. Audit columns added: `original_genre` (immutable), `genre_changed_at`, `genre_changed_by`, `genre_change_count`. Changing the parent genre clears `sub_genre` unless the request explicitly sets a new one.";
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
