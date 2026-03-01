// supabase/functions/verify-email/index.ts
// POST /functions/v1/verify-email
// Body: { action: "send", email } — sends 6-digit verification code
// Body: { action: "verify", email, code } — verifies code
// SECURITY: Rate limited, CORS restricted, codes expire in 10 minutes

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

    // ─── RATE LIMITING: per IP ─────────────────────────────────────────
    const clientIp =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("cf-connecting-ip") ||
      "unknown";

    const { data: recentAttempts } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "verify_email")
      .eq("identifier", clientIp)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentAttempts && recentAttempts.length >= 20) {
      return new Response(
        JSON.stringify({ error: "Too many verification attempts. Try again later." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({
      action: "verify_email",
      identifier: clientIp,
    });

    // ─── PARSE INPUT ───────────────────────────────────────────────────
    const body = await req.json();
    const { action, email, code } = body;

    if (!email || typeof email !== "string") {
      return new Response(
        JSON.stringify({ error: "Email is required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    const normalizedEmail = email.trim().toLowerCase();
    if (!emailRegex.test(normalizedEmail)) {
      return new Response(
        JSON.stringify({ error: "Invalid email address format" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ═════════════════════════════════════════════════════════════════════
    //  ACTION: SEND — generate and email a 6-digit code
    // ═════════════════════════════════════════════════════════════════════
    if (action === "send") {
      // Check per-email rate limit: max 5 sends per hour
      const { data: recentSends } = await supabase
        .from("email_verifications")
        .select("id")
        .eq("email", normalizedEmail)
        .gte("created_at", new Date(Date.now() - 3600000).toISOString());

      if (recentSends && recentSends.length >= 5) {
        return new Response(
          JSON.stringify({ error: "Too many verification emails sent. Please check your inbox or try again later." }),
          { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Generate 6-digit code
      const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

      // Store in DB
      const { error: insertError } = await supabase
        .from("email_verifications")
        .insert({
          email: normalizedEmail,
          code: verifyCode,
          expires_at: expiresAt,
          verified: false,
        });

      if (insertError) throw insertError;

      // Send via Resend
      const resendApiKey = Deno.env.get("RESEND_API_KEY");
      if (!resendApiKey) {
        console.error("RESEND_API_KEY not configured");
        return new Response(
          JSON.stringify({ error: "Email service not configured" }),
          { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "MusiClaw <noreply@contact.musiclaw.app>",
          to: [normalizedEmail],
          subject: "Your MusiClaw verification code",
          html: `
            <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0e0e14;color:#f0f0f0;padding:32px;border-radius:16px;">
              <h1 style="color:#22c55e;font-size:24px;margin:0 0 16px;">Verify Your Email</h1>
              <p style="color:rgba(255,255,255,0.7);line-height:1.6;">
                Enter this code to continue with your purchase on MusiClaw:
              </p>
              <div style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:12px;padding:20px;text-align:center;margin:20px 0;">
                <span style="font-size:36px;font-weight:800;letter-spacing:8px;color:#22c55e;font-family:monospace;">${verifyCode}</span>
              </div>
              <p style="color:rgba(255,255,255,0.35);font-size:12px;margin-top:24px;">
                This code expires in 10 minutes. If you didn't request this, ignore this email.
              </p>
              <p style="color:rgba(255,255,255,0.2);font-size:11px;margin-top:16px;">
                MusiClaw.app &mdash; Where AI agents find their voice
              </p>
            </div>
          `,
        }),
      });

      if (!emailRes.ok) {
        const errText = await emailRes.text();
        console.error("Resend email failed:", errText);
        return new Response(
          JSON.stringify({ error: "Failed to send verification email. Please try again." }),
          { status: 502, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      console.log(`Verification code sent successfully`);
      return new Response(
        JSON.stringify({ success: true, message: "Verification code sent to your email." }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ═════════════════════════════════════════════════════════════════════
    //  ACTION: VERIFY — check the 6-digit code
    // ═════════════════════════════════════════════════════════════════════
    if (action === "verify") {
      if (!code || typeof code !== "string" || code.length !== 6) {
        return new Response(
          JSON.stringify({ error: "A 6-digit verification code is required" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // ─── PER-EMAIL BRUTE FORCE PROTECTION: max 5 failed attempts/hr ──
      const { data: failedAttempts } = await supabase
        .from("rate_limits")
        .select("id")
        .eq("action", "verify_fail")
        .eq("identifier", normalizedEmail)
        .gte("created_at", new Date(Date.now() - 3600000).toISOString());

      if (failedAttempts && failedAttempts.length >= 5) {
        return new Response(
          JSON.stringify({ error: "Too many failed verification attempts for this email. Try again in an hour." }),
          { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Look up valid code
      const { data: verification } = await supabase
        .from("email_verifications")
        .select("id, verified")
        .eq("email", normalizedEmail)
        .eq("code", code)
        .gte("expires_at", new Date().toISOString())
        .eq("verified", false)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!verification) {
        // Track failed attempt per email
        await supabase.from("rate_limits").insert({
          action: "verify_fail",
          identifier: normalizedEmail,
        });

        return new Response(
          JSON.stringify({ error: "Invalid or expired verification code. Please request a new one." }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Mark as verified
      await supabase
        .from("email_verifications")
        .update({ verified: true })
        .eq("id", verification.id);

      console.log(`Email verified successfully`);
      return new Response(
        JSON.stringify({ success: true, verified: true }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid action. Use 'send' or 'verify'." }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Verify email error:", err.message);
    return new Response(
      JSON.stringify({ error: "Verification failed. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
