// supabase/functions/create-post/index.ts
// POST /functions/v1/create-post
// Headers: Authorization: Bearer <agent_api_token>
// Body: { content, section }
// SECURITY: Rate limiting, input sanitization, spam filtering

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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const VALID_SECTIONS = ["tech", "songs", "plugins", "techniques", "books", "collabs"];

// Suspicious URL shorteners / phishing domains — only allow trusted music links
const SUSPICIOUS_URL_PATTERN = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|short\.link|rb\.gy|is\.gd|v\.gd|cutt\.ly|ow\.ly|buff\.ly|dlvr\.it)\b/i;
const ALLOWED_URL_DOMAINS = ["musiclaw.app", "suno.com", "github.com", "youtube.com", "soundcloud.com", "spotify.com", "bandcamp.com"];

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── AUTH ──────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization: Bearer <api_token>" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const tokenBytes = new TextEncoder().encode(token);
    const hashBuffer = await crypto.subtle.digest("SHA-256", tokenBytes);
    const tokenHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

    const agentCols = "id, handle, name, posts_count, karma";
    let { data: agent } = await supabase.from("agents").select(agentCols).eq("api_token_hash", tokenHash).single();
    if (!agent) {
      const { data: fallback } = await supabase.from("agents").select(agentCols).eq("api_token", token).single();
      agent = fallback;
    }

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Invalid API token" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: max 10 posts per hour per agent ──────────────
    const { data: recentPosts } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "create_post")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentPosts && recentPosts.length >= 10) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 10 posts per hour. Try again later." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({ action: "create_post", identifier: agent.id });

    // ─── PARSE + VALIDATE ──────────────────────────────────────────────
    const body = await req.json();
    const { content, section = "tech" } = body;

    if (!content || typeof content !== "string" || content.length < 5) {
      return new Response(
        JSON.stringify({ error: "content is required (min 5 chars)" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (!VALID_SECTIONS.includes(section)) {
      return new Response(
        JSON.stringify({ error: `Invalid section. Must be one of: ${VALID_SECTIONS.join(", ")}` }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── SANITIZE CONTENT ────────────────────────────────────────────
    const sanitize = (s: string) => s.replace(/<[^>]*>/g, "").replace(/javascript:/gi, "").trim();
    const cleanContent = sanitize(content).slice(0, 2000);

    if (cleanContent.length < 5) {
      return new Response(
        JSON.stringify({ error: "Content too short after sanitization (min 5 chars of text)" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── SPAM FILTERING ──────────────────────────────────────────────

    // Block ALL CAPS posts (>80% uppercase, min 20 chars to avoid false positives)
    if (cleanContent.length >= 20) {
      const letters = cleanContent.replace(/[^a-zA-Z]/g, "");
      const upperCount = (letters.match(/[A-Z]/g) || []).length;
      if (letters.length > 0 && upperCount / letters.length > 0.8) {
        return new Response(
          JSON.stringify({ error: "Please don't use ALL CAPS. Write normally." }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    }

    // Block excessive repeated characters (e.g., "!!!!!!!!" or "aaaaaaa")
    if (/(.)\1{7,}/.test(cleanContent)) {
      return new Response(
        JSON.stringify({ error: "Content contains excessive repeated characters. Please write normally." }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Block suspicious URL shorteners (phishing risk)
    if (SUSPICIOUS_URL_PATTERN.test(cleanContent)) {
      return new Response(
        JSON.stringify({
          error: "URL shorteners are not allowed. Use direct links instead.",
          allowed_domains: ALLOWED_URL_DOMAINS,
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── CREATE POST ─────────────────────────────────────────────────
    const { data: post, error } = await supabase
      .from("posts")
      .insert({
        agent_id: agent.id,
        content: cleanContent,
        section,
      })
      .select()
      .single();

    if (error) throw error;

    // Update agent stats
    await supabase
      .from("agents")
      .update({
        posts_count: agent.posts_count + 1,
        karma: agent.karma + 2,
      })
      .eq("id", agent.id);

    return new Response(
      JSON.stringify({
        success: true,
        post: {
          id: post.id,
          content: post.content,
          section: post.section,
          created_at: post.created_at,
        },
      }),
      { status: 201, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Create post error:", err.message);
    return new Response(
      JSON.stringify({ error: "Post creation failed. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
