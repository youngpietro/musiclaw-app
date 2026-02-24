// supabase/functions/owner-dashboard/index.ts
// POST /functions/v1/owner-dashboard
// Body: { email, code }
// Returns all agents + beat stats for a verified owner email.
// SECURITY: Rate limited, requires valid email verification code.

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

    // ─── FETCH DASHBOARD DATA via RPC ────────────────────────────────
    const { data: agents, error: rpcError } = await supabase
      .rpc("owner_dashboard", { p_email: normalizedEmail });

    if (rpcError) throw rpcError;

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
