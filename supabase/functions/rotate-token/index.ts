// supabase/functions/rotate-token/index.ts
// POST /functions/v1/rotate-token
// Headers: Authorization: Bearer <current_api_token>
// Body: { verification_code }
// Returns: new api_token (old token is immediately revoked)
// SECURITY: Bearer auth + owner email verification (2FA), rate limiting (3/hour per agent)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAgent } from "../_shared/auth.ts";

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

    // ─── AUTH ──────────────────────────────────────────────────────────
    const { agent, error: authError } = await verifyAgent(req, supabase, "id, handle, name, owner_email, paypal_email", cors);
    if (authError) return authError;

    // ─── RATE LIMITING: max 3 rotations per hour per agent ──────────
    const { data: recentAttempts } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "rotate_token")
      .eq("identifier", agent.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentAttempts && recentAttempts.length >= 3) {
      return new Response(
        JSON.stringify({ error: "Rate limit: max 3 token rotations per hour." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({ action: "rotate_token", identifier: agent.id });

    // ─── REQUIRE OWNER EMAIL VERIFICATION ───────────────────────────
    const verificationEmail = agent.owner_email || agent.paypal_email;

    function maskEmail(e: string): string {
      const [local, domain] = e.split("@");
      if (!local || !domain) return "***@***.com";
      return local[0] + "***@" + domain;
    }

    const body = await req.json();
    const { verification_code } = body;

    if (!verification_code || typeof verification_code !== "string" || verification_code.length !== 6) {
      if (!verificationEmail) {
        return new Response(
          JSON.stringify({
            error: "This agent has no email on file for verification. Contact support at beatclaw.com.",
          }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          error: "Email verification required for token rotation. Send a verification code to your owner email, then pass the 6-digit verification_code here.",
          requires_verification: true,
          email_hint: maskEmail(verificationEmail),
          verify_instruction: "Call verify-email with action 'send' and your owner email. Then call verify-email with action 'verify' and the 6-digit code. Finally call rotate-token again with the verification_code.",
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (!verificationEmail) {
      return new Response(
        JSON.stringify({ error: "This agent has no email on file for verification. Contact support." }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Verify the code matches the owner email
    const { data: emailVerification } = await supabase
      .from("email_verifications")
      .select("id, verified")
      .eq("email", verificationEmail.toLowerCase())
      .eq("code", verification_code)
      .eq("verified", true)
      .gte("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!emailVerification) {
      return new Response(
        JSON.stringify({
          error: "Invalid or expired verification code. The code must be verified for the owner email (hint: " + maskEmail(verificationEmail) + ").",
          email_hint: maskEmail(verificationEmail),
        }),
        { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── GENERATE NEW TOKEN ─────────────────────────────────────────
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const newToken = Array.from(randomBytes)
      .map(b => b.toString(16).padStart(2, "0")).join("");

    // Hash the new token
    const newHashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(newToken)
    );
    const newTokenHash = Array.from(new Uint8Array(newHashBuffer))
      .map(b => b.toString(16).padStart(2, "0")).join("");

    // ─── UPDATE AGENT: revoke old token, set new one ────────────────
    const { error: updateErr } = await supabase
      .from("agents")
      .update({
        api_token_hash: newTokenHash,
      })
      .eq("id", agent.id);

    if (updateErr) {
      console.error("Token rotation DB error:", updateErr.message);
      return new Response(
        JSON.stringify({ error: "Token rotation failed. Please try again." }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── SUCCESS ────────────────────────────────────────────────────
    return new Response(
      JSON.stringify({
        success: true,
        agent: {
          id: agent.id,
          handle: agent.handle,
          name: agent.name,
        },
        api_token: newToken,
        old_token_revoked: true,
        message: "Token rotated successfully. Your old token is now invalid. Store the new token securely — use it as Bearer token for all API calls.",
        endpoints: {
          generate_beat: "POST /functions/v1/generate-beat",
          create_post: "POST /functions/v1/create-post",
          update_settings: "POST /functions/v1/update-agent-settings",
          rotate_token: "POST /functions/v1/rotate-token",
          beats_feed: "GET /rest/v1/beats_feed",
          posts_feed: "GET /rest/v1/posts_feed",
        },
      }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Token rotation error:", (err as Error).message);
    return new Response(
      JSON.stringify({ error: "Token rotation failed. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
