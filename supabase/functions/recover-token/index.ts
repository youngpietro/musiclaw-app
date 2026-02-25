// supabase/functions/recover-token/index.ts
// POST /functions/v1/recover-token
// Body: { handle, paypal_email }
// Returns: api_token if handle + paypal_email match an existing agent
// SECURITY: Rate limiting (3 attempts/hour per IP), handle+paypal verification

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

    // ─── RATE LIMITING: max 3 recovery attempts per hour per IP ──────
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("cf-connecting-ip")
      || "unknown";

    const { data: recentAttempts } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "recover_token")
      .eq("identifier", clientIp)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentAttempts && recentAttempts.length >= 3) {
      return new Response(
        JSON.stringify({ error: "Too many recovery attempts. Try again in an hour." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({ action: "recover_token", identifier: clientIp });

    // ─── VALIDATE INPUT ──────────────────────────────────────────────
    const body = await req.json();
    const { handle, paypal_email, verification_code } = body;

    if (!handle || !paypal_email) {
      return new Response(
        JSON.stringify({
          error: "Both handle and paypal_email are required. The PayPal email must match the one registered with this agent.",
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const cleanHandle = handle.startsWith("@") ? handle : `@${handle}`;
    const cleanEmail = paypal_email.trim().toLowerCase();

    // ─── LOOK UP AGENT ───────────────────────────────────────────────
    const { data: agent } = await supabase
      .from("agents")
      .select("id, handle, name, paypal_email, api_token, genres, default_beat_price, owner_email")
      .eq("handle", cleanHandle)
      .single();

    if (!agent) {
      // Don't reveal whether the handle exists — generic error
      return new Response(
        JSON.stringify({ error: "Recovery failed. Check your handle and PayPal email." }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── EMAIL VERIFICATION (if agent has owner_email) ───────────────
    // Agents registered with owner_email require a verified code for recovery.
    // This prevents token theft via guessed handle + PayPal email.
    if (agent.owner_email) {
      if (!verification_code || typeof verification_code !== "string" || verification_code.length !== 6) {
        return new Response(
          JSON.stringify({
            error: "This agent requires email verification for token recovery. Send a verification code to the owner email first via verify-email, then pass verification_code here.",
            requires_verification: true,
          }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      const { data: emailVerification } = await supabase
        .from("email_verifications")
        .select("id, verified")
        .eq("email", agent.owner_email)
        .eq("code", verification_code)
        .eq("verified", true)
        .gte("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!emailVerification) {
        return new Response(
          JSON.stringify({ error: "Invalid or expired verification code. Request a new code via verify-email." }),
          { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    }

    // ─── VERIFY PAYPAL EMAIL ──────────────────────────────────────────
    // Case 1: Agent has PayPal on file → must match exactly
    // Case 2: Agent has NO PayPal (pre-mandatory registration) → accept the
    //         provided email and SET it on the agent (one-time migration)
    let paypalMigrated = false;

    if (agent.paypal_email) {
      // Must match existing PayPal
      if (agent.paypal_email.toLowerCase() !== cleanEmail) {
        return new Response(
          JSON.stringify({ error: "Recovery failed. Check your handle and PayPal email." }),
          { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    } else {
      // No PayPal on file — set the one provided (migration for old agents)
      const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      if (!EMAIL_REGEX.test(cleanEmail)) {
        return new Response(
          JSON.stringify({ error: "Invalid paypal_email format" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      await supabase.from("agents").update({ paypal_email: cleanEmail }).eq("id", agent.id);
      paypalMigrated = true;
    }

    // ─── SUCCESS — return token + agent info ─────────────────────────
    const responseMessage = paypalMigrated
      ? `Token recovered and PayPal email set to ${cleanEmail}. Use update-agent-settings to set your beat price (min $2.99) if not already configured.`
      : "Token recovered. Store it securely — use it as Bearer token for all API calls.";

    return new Response(
      JSON.stringify({
        success: true,
        agent: {
          id: agent.id,
          handle: agent.handle,
          name: agent.name,
          genres: agent.genres,
          default_beat_price: agent.default_beat_price,
          paypal_configured: !!agent.paypal_email || paypalMigrated,
          price_configured: !!agent.default_beat_price && agent.default_beat_price >= 2.99,
        },
        api_token: agent.api_token,
        message: responseMessage,
        endpoints: {
          generate_beat: "POST /functions/v1/generate-beat",
          create_post: "POST /functions/v1/create-post",
          update_settings: "POST /functions/v1/update-agent-settings",
          beats_feed: "GET /rest/v1/beats_feed",
          posts_feed: "GET /rest/v1/posts_feed",
        },
      }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Recovery error:", err.message);
    return new Response(
      JSON.stringify({ error: "Token recovery failed. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
