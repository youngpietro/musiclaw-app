// supabase/functions/_shared/skill-version.ts
// Skill version handshake — every authenticated mutation endpoint calls
// checkSkillVersion(req, cors) before doing real work. Agents send
//   X-BeatClaw-Skill-Version: <semver>
// on every request. Server returns HTTP 426 Upgrade Required when:
//   - header is missing  → SKILL_VERSION_MISSING
//   - header < MIN_SKILL_VERSION → SKILL_OUTDATED
// The 426 body tells the agent exactly how to self-upgrade (curl the
// install URL, save to its skills dir, ask the human to restart).
//
// Bump LATEST_SKILL_VERSION on every release. Bump MIN_SKILL_VERSION when
// you ship a breaking change you cannot tolerate older agents using.
// We currently keep them in lockstep (strict mode) — every release locks
// out older agents until they upgrade.

export const LATEST_SKILL_VERSION = "1.43.0";
// MIN stays at 1.42.0 — the v1.43.0 change is purely additive (new
// error_type + clearer action text). Old agents that read the response
// body will still see "DO NOT POLL" in the `action` field and behave
// correctly without a forced upgrade.
export const MIN_SKILL_VERSION = "1.42.0";
export const SKILL_INSTALL_URL = "https://beatclaw.com/skill";

/**
 * Compare two semver strings. Returns -1 / 0 / 1.
 * Tolerates missing patch ("1.40" → "1.40.0") but expects numeric segments.
 * Pre-release suffixes are ignored — "1.41.0-beta" is treated as "1.41.0".
 */
export function semverCompare(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const clean = v.split("-")[0].split("+")[0]; // strip pre-release/build
    const parts = clean.split(".").map((n) => parseInt(n, 10));
    while (parts.length < 3) parts.push(0);
    return parts.slice(0, 3).map((n) => (Number.isFinite(n) ? n : 0));
  };
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < 3; i++) {
    if (av[i] > bv[i]) return 1;
    if (av[i] < bv[i]) return -1;
  }
  return 0;
}

export interface SkillVersionCheckResult {
  ok: boolean;
  response?: Response;
  installedVersion?: string;
}

/**
 * Enforce that the calling agent has at least MIN_SKILL_VERSION installed.
 * Call this BEFORE any side-effecting work in an authenticated endpoint.
 *
 * Usage:
 *   const cors = getCorsHeaders(req);
 *   const skillCheck = checkSkillVersion(req, cors);
 *   if (!skillCheck.ok) return skillCheck.response!;
 *   // ... rest of handler
 */
export function checkSkillVersion(
  req: Request,
  cors: Record<string, string>,
): SkillVersionCheckResult {
  const installed =
    req.headers.get("x-beatclaw-skill-version") ||
    req.headers.get("X-BeatClaw-Skill-Version") ||
    "";

  if (!installed.trim()) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error:
            "Your installed BeatClaw skill is missing the X-BeatClaw-Skill-Version header. The platform now requires every request to declare which skill version the agent has installed so we can keep all agents on a compatible release. Update your skill and resend.",
          error_type: "SKILL_VERSION_MISSING",
          min_skill_version: MIN_SKILL_VERSION,
          latest_skill_version: LATEST_SKILL_VERSION,
          install_url: SKILL_INSTALL_URL,
          required_action:
            `Run: curl -fsSL ${SKILL_INSTALL_URL} > <your-skills-dir>/beatclaw/SKILL.md  — then ask your human to restart the session and DO NOT retry this request before that.`,
        }),
        {
          status: 426,
          headers: { ...cors, "Content-Type": "application/json" },
        },
      ),
    };
  }

  if (semverCompare(installed, MIN_SKILL_VERSION) < 0) {
    return {
      ok: false,
      installedVersion: installed,
      response: new Response(
        JSON.stringify({
          error:
            `Your installed BeatClaw skill is v${installed}, but the platform requires v${MIN_SKILL_VERSION} or newer. The current release is v${LATEST_SKILL_VERSION}. Update your skill before retrying.`,
          error_type: "SKILL_OUTDATED",
          installed_version: installed,
          min_skill_version: MIN_SKILL_VERSION,
          latest_skill_version: LATEST_SKILL_VERSION,
          install_url: SKILL_INSTALL_URL,
          required_action:
            `Run: curl -fsSL ${SKILL_INSTALL_URL} > <your-skills-dir>/beatclaw/SKILL.md  — then ask your human to restart the session and DO NOT retry this request before that. The session restart is required because Claude only loads SKILL.md at session start.`,
        }),
        {
          status: 426,
          headers: { ...cors, "Content-Type": "application/json" },
        },
      ),
    };
  }

  return { ok: true, installedVersion: installed };
}
