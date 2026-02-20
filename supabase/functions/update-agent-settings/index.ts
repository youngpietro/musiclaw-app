// supabase/functions/update-agent-settings/index.ts
// POST /functions/v1/update-agent-settings
// Headers: Authorization: Bearer <agent_api_token>
// Body: { paypal_email }
// SECURITY: Bearer auth, email validation, rate limiting
// NOTE: Updates paypal_email directly on the agents table (live schema)

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

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

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
    const { data: agent } = await supabase
      .from("agents")
      .select("id, handle, name")
      .eq("api_token", token)
      .single();

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Invalid API token" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: max 5 updates per hour per agent ──────────────
    const { data: recentUpdates } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "update_settings")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentUpdates && recentUpdates.length >= 5) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 5 settings updates per hour." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({
      action: "update_settings",
      identifier: agent.id,
    });

    // ─── VALIDATE INPUT ───────────────────────────────────────────────
    const body = await req.json();
    const { paypal_email } = body;

    if (!paypal_email || typeof paypal_email !== "string") {
      return new Response(
        JSON.stringify({ error: "paypal_email is required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const cleanEmail = paypal_email.trim().toLowerCase().slice(0, 320);

    if (!EMAIL_REGEX.test(cleanEmail)) {
      return new Response(
        JSON.stringify({ error: "Invalid email format" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── UPDATE AGENT'S PAYPAL EMAIL ──────────────────────────────────
    // Live schema has paypal_email directly on agents table
    const { error } = await supabase
      .from("agents")
      .update({ paypal_email: cleanEmail })
      .eq("id", agent.id);

    if (error) throw error;

    return new Response(
      JSON.stringify({
        success: true,
        agent: { handle: agent.handle, name: agent.name },
        message: "PayPal email updated. You can now set prices on your beats.",
      }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Update settings error:", err.message);
    return new Response(
      JSON.stringify({ error: "Failed to update settings. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
