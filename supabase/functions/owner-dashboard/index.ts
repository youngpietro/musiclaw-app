// supabase/functions/owner-dashboard/index.ts
// POST /functions/v1/owner-dashboard
// Body (default — fetch dashboard): { email, code }
// Body (genre fix):                  { email, code, action: "update_genre", beat_id, genre, sub_genre? }
// Returns all agents + beat stats for a verified owner email, OR
// reclassifies a single beat the owner has authority over.
// Owners bypass the agent-side per-beat reclassification cap.
// SECURITY: Rate limited, requires valid email verification code.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateGenre } from "../_shared/genres.ts";

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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── RATE LIMITING: max 10 dashboard requests per hour per IP ────
    const clientIp =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("cf-connecting-ip") ||
      "unknown";

    const { data: recentAttempts } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "owner_dashboard")
      .eq("identifier", clientIp)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentAttempts && recentAttempts.length >= 10) {
      return new Response(
        JSON.stringify({ error: "Too many attempts. Try again later." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({
      action: "owner_dashboard",
      identifier: clientIp,
    });

    // ─── PARSE INPUT ─────────────────────────────────────────────────
    const body = await req.json();
    const { email, code } = body;

    if (!email || typeof email !== "string") {
      return new Response(
        JSON.stringify({ error: "Email is required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const normalizedEmail = email.trim().toLowerCase();
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(normalizedEmail)) {
      return new Response(
        JSON.stringify({ error: "Invalid email format" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (!code || typeof code !== "string" || code.length !== 6) {
      return new Response(
        JSON.stringify({ error: "A 6-digit verification code is required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── VERIFY CODE ─────────────────────────────────────────────────
    const { data: verification } = await supabase
      .from("email_verifications")
      .select("id, verified")
      .eq("email", normalizedEmail)
      .eq("code", code)
      .eq("verified", true)
      .gte("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!verification) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired verification code. Please request a new code." }),
        { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── ACTION: update_genre ────────────────────────────────────────
    // Owners can reclassify any beat owned by an agent under their
    // owner_email — no per-beat cap (the cap is an agent-side guardrail).
    if (body.action === "update_genre") {
      const { beat_id, genre, sub_genre } = body;
      if (!beat_id) {
        return new Response(
          JSON.stringify({ error: "beat_id is required" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      if (!genre && (sub_genre === undefined || sub_genre === null)) {
        return new Response(
          JSON.stringify({ error: "Provide at least one of: genre, sub_genre" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Authorize: the beat must belong to an agent whose owner_email
      // matches the verified caller.
      const { data: beatRow } = await supabase
        .from("beats")
        .select("id, title, genre, sub_genre, original_genre, genre_change_count, sold, deleted_at, status, agent_id, agents!inner(owner_email)")
        .eq("id", beat_id)
        .single();

      // deno-lint-ignore no-explicit-any
      const ownerEmail = (beatRow as any)?.agents?.owner_email;
      if (!beatRow || !ownerEmail || ownerEmail.toLowerCase() !== normalizedEmail) {
        return new Response(
          JSON.stringify({ error: "Beat not found or you don't own the agent that created it." }),
          { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      if (beatRow.sold) {
        return new Response(
          JSON.stringify({ error: "Cannot reclassify a sold beat." }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      if (beatRow.deleted_at) {
        return new Response(
          JSON.stringify({ error: "Cannot reclassify a deleted beat." }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      if (beatRow.status !== "complete") {
        return new Response(
          JSON.stringify({ error: "Cannot reclassify — beat is still generating." }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // deno-lint-ignore no-explicit-any
      const updateData: Record<string, any> = {};
      const changes: string[] = [];
      let newGenre = beatRow.genre as string;

      if (genre) {
        const validation = await validateGenre(supabase, String(genre));
        if (!validation.ok) {
          return new Response(
            JSON.stringify(validation),
            { status: validation.status, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }
        newGenre = validation.genre;
        if (newGenre !== beatRow.genre) {
          updateData.genre = newGenre;
          changes.push(`genre: "${beatRow.genre}" → "${newGenre}"`);
          // Reset sub_genre if parent changed and caller didn't provide one
          if (sub_genre === undefined || sub_genre === null) {
            updateData.sub_genre = null;
          }
        }
      }

      if (sub_genre !== undefined && sub_genre !== null) {
        const cleanSub = String(sub_genre).trim().toLowerCase();
        if (cleanSub === "") {
          updateData.sub_genre = null;
          changes.push(`sub_genre: "${beatRow.sub_genre || "(none)"}" → (cleared)`);
        } else {
          const { data: subRow } = await supabase
            .from("genres")
            .select("id, parent_id")
            .eq("id", cleanSub)
            .not("parent_id", "is", null)
            .single();
          if (!subRow) {
            return new Response(
              JSON.stringify({ error: `Unknown sub_genre "${cleanSub}".` }),
              { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
            );
          }
          if (subRow.parent_id !== newGenre) {
            return new Response(
              JSON.stringify({
                error: `Sub-genre "${cleanSub}" belongs to parent "${subRow.parent_id}", not "${newGenre}".`,
              }),
              { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
            );
          }
          updateData.sub_genre = cleanSub;
          changes.push(`sub_genre: "${beatRow.sub_genre || "(none)"}" → "${cleanSub}"`);
        }
      }

      if (Object.keys(updateData).length === 0) {
        return new Response(
          JSON.stringify({
            error: `No change applied — beat is already "${beatRow.genre}"${beatRow.sub_genre ? ` / "${beatRow.sub_genre}"` : ""}.`,
          }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Audit columns — only mark genre_changed_* if parent genre changed
      if (updateData.genre) {
        updateData.genre_change_count = ((beatRow.genre_change_count as number) || 0) + 1;
        updateData.genre_changed_at = new Date().toISOString();
        updateData.genre_changed_by = "owner";
        if (!beatRow.original_genre) {
          updateData.original_genre = beatRow.genre;
        }
      }

      const { error: updateErr } = await supabase
        .from("beats")
        .update(updateData)
        .eq("id", beatRow.id);

      if (updateErr) throw updateErr;

      return new Response(
        JSON.stringify({
          success: true,
          beat: {
            id: beatRow.id,
            title: beatRow.title,
            genre: updateData.genre ?? beatRow.genre,
            sub_genre: updateData.sub_genre !== undefined ? updateData.sub_genre : beatRow.sub_genre,
            original_genre: beatRow.original_genre || beatRow.genre,
            genre_change_count: updateData.genre_change_count ?? beatRow.genre_change_count ?? 0,
          },
          changes,
          message: `Beat reclassified by owner: ${changes.join(", ")}`,
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── FETCH DASHBOARD DATA via RPC ────────────────────────────────
    const { data: agents, error: rpcError } = await supabase
      .rpc("owner_dashboard", { p_email: normalizedEmail });

    if (rpcError) throw rpcError;

    // Cookie life data comes through the owner_dashboard() RPC automatically
    // (suno_credits_left, suno_monthly_limit, suno_credits_checked_at per agent)

    return new Response(
      JSON.stringify({
        success: true,
        email: normalizedEmail,
        agents: agents || [],
        agent_count: Array.isArray(agents) ? agents.length : 0,
      }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Owner dashboard error:", err.message);
    return new Response(
      JSON.stringify({ error: "Dashboard request failed. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
