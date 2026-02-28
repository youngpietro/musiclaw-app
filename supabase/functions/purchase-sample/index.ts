// supabase/functions/purchase-sample/index.ts
// POST /functions/v1/purchase-sample
// Body: { sample_id }
// Purchases a sample using credits: deducts 1 credit, marks sample as purchased,
// records purchase, credits agent earnings, returns signed download token.
// SECURITY: Requires Supabase Auth JWT, atomic credit deduction, rate limited

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

async function hmacSign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const bytes = new Uint8Array(signature);
  let b64 = btoa(String.fromCharCode(...bytes));
  b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b64;
}

// Credit value: 1 credit = $0.05, agent gets 80% = $0.04
const CREDIT_VALUE_USD = 0.05;
const AGENT_SHARE = 0.8;

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const signingSecret = Deno.env.get("DOWNLOAD_SIGNING_SECRET");

    if (!signingSecret) {
      console.error("DOWNLOAD_SIGNING_SECRET not configured");
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── AUTHENTICATE USER ──────────────────────────────────────────
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Authentication required. Please log in." }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired session. Please log in again." }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ─── RATE LIMIT: max 60 sample purchases per hour ───────────────
    const { data: recentPurchases } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "purchase_sample")
      .eq("identifier", user.id)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentPurchases && recentPurchases.length >= 60) {
      return new Response(
        JSON.stringify({ error: "Too many purchases. Try again later." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({
      action: "purchase_sample",
      identifier: user.id,
    });

    // ─── VALIDATE INPUT ─────────────────────────────────────────────
    const body = await req.json();
    const { sample_id } = body;

    if (!sample_id) {
      return new Response(
        JSON.stringify({ error: "sample_id is required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP SAMPLE ─────────────────────────────────────────────
    const { data: sample } = await supabase
      .from("samples")
      .select("id, beat_id, stem_type, audio_url, credit_price, purchased_by")
      .eq("id", sample_id)
      .single();

    if (!sample) {
      return new Response(
        JSON.stringify({ error: "Sample not found" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (sample.purchased_by) {
      return new Response(
        JSON.stringify({ error: "This sample has already been purchased" }),
        { status: 410, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── CHECK IF PARENT BEAT IS SOLD ─────────────────────────────────
    const { data: parentBeat } = await supabase
      .from("beats")
      .select("sold")
      .eq("id", sample.beat_id)
      .single();

    if (parentBeat?.sold) {
      return new Response(
        JSON.stringify({ error: "This beat has been sold. Its samples are no longer available." }),
        { status: 410, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── CHECK USER CREDITS ─────────────────────────────────────────
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("credit_balance")
      .eq("id", user.id)
      .single();

    const currentBalance = profile?.credit_balance || 0;
    if (currentBalance < sample.credit_price) {
      return new Response(
        JSON.stringify({
          error: "Not enough credits",
          credits_needed: sample.credit_price,
          credits_available: currentBalance,
        }),
        { status: 402, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── ATOMIC PURCHASE: deduct credits + mark sample + record ─────
    // Deduct credits (use conditional update to prevent race conditions)
    const { data: updatedProfile, error: creditErr } = await supabase
      .from("user_profiles")
      .update({
        credit_balance: currentBalance - sample.credit_price,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id)
      .gte("credit_balance", sample.credit_price)
      .select("credit_balance")
      .single();

    if (creditErr || !updatedProfile) {
      return new Response(
        JSON.stringify({ error: "Failed to deduct credits. Please try again." }),
        { status: 409, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Mark sample as purchased
    const { error: sampleErr } = await supabase
      .from("samples")
      .update({
        purchased_by: user.id,
        purchased_at: new Date().toISOString(),
      })
      .eq("id", sample.id)
      .is("purchased_by", null); // Race condition guard

    if (sampleErr) {
      // Rollback credits
      await supabase
        .from("user_profiles")
        .update({ credit_balance: currentBalance })
        .eq("id", user.id);

      return new Response(
        JSON.stringify({ error: "Sample was just purchased by someone else. Credits refunded." }),
        { status: 409, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Calculate agent earning
    const agentEarning = Math.round(sample.credit_price * CREDIT_VALUE_USD * AGENT_SHARE * 100) / 100;

    // Generate download token
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    const tokenPayload = `sample:${sample.id}:${user.id}:${expiresAt.toISOString()}`;
    const signature = await hmacSign(tokenPayload, signingSecret);
    const downloadToken = btoa(tokenPayload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") +
      "." + signature;

    // Record purchase
    await supabase.from("sample_purchases").insert({
      sample_id: sample.id,
      user_id: user.id,
      credits_spent: sample.credit_price,
      agent_earning: agentEarning,
      download_token: downloadToken,
      download_expires: expiresAt.toISOString(),
    });

    // Credit agent earnings
    const { data: beat } = await supabase
      .from("beats")
      .select("agent_id, title, genre")
      .eq("id", sample.beat_id)
      .single();

    if (beat) {
      await supabase.rpc("increment_agent_sample_earnings", {
        p_agent_id: beat.agent_id,
        p_amount: agentEarning,
      }).then(({ error }) => {
        if (error) {
          // Fallback: direct update
          supabase
            .from("agents")
            .select("pending_sample_earnings")
            .eq("id", beat.agent_id)
            .single()
            .then(({ data: agent }) => {
              if (agent) {
                supabase
                  .from("agents")
                  .update({
                    pending_sample_earnings: (parseFloat(agent.pending_sample_earnings) || 0) + agentEarning,
                  })
                  .eq("id", beat.agent_id);
              }
            });
        }
      });
    }

    const downloadUrl = `${supabaseUrl}/functions/v1/download-sample?token=${encodeURIComponent(downloadToken)}`;

    console.log(`Sample ${sample.id} (${sample.stem_type}) purchased by user ${user.id} — agent earning: $${agentEarning}`);

    // ─── SEND DOWNLOAD EMAIL VIA RESEND ──────────────────────────────
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const userEmail = user.email;
    if (resendApiKey && userEmail) {
      try {
        const beatTitle = beat?.title || "Beat";
        const stemLabel = (sample.stem_type || "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
        const genre = beat?.genre || "";

        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "MusiClaw <noreply@contact.musiclaw.app>",
            to: [userEmail],
            subject: `Your sample is ready: ${beatTitle} - ${stemLabel} — MusiClaw`,
            html: `
              <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0e0e14;color:#f0f0f0;padding:32px;border-radius:16px;">
                <h1 style="color:#a855f7;font-size:24px;margin:0 0 16px;">Sample Purchased!</h1>
                <p style="color:rgba(255,255,255,0.7);line-height:1.6;">
                  Your sample <strong>&ldquo;${beatTitle} &mdash; ${stemLabel}&rdquo;</strong>${genre ? ` (${genre})` : ""} is ready to download.
                </p>
                <p style="color:rgba(255,255,255,0.5);font-size:13px;">
                  Credits spent: <strong>${sample.credit_price}</strong>
                </p>
                <a href="${downloadUrl}" style="display:inline-block;background:#a855f7;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;margin:20px 0;">
                  Download ${stemLabel}
                </a>
                <p style="color:rgba(255,255,255,0.35);font-size:12px;margin-top:24px;">
                  This link expires in 24 hours. Maximum 5 downloads.<br/>
                  Every AI-generated sample includes a commercial license.
                </p>
                <p style="color:rgba(255,255,255,0.2);font-size:11px;margin-top:16px;">
                  MusiClaw.app &mdash; Where AI agents find their voice
                </p>
              </div>
            `,
          }),
        });
        console.log(`Sample purchase email sent to ${userEmail}`);
      } catch (emailErr: unknown) {
        console.error("Sample purchase email error:", (emailErr as Error).message);
        // Non-fatal: purchase succeeded even if email fails
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        download_url: downloadUrl,
        new_balance: updatedProfile.credit_balance,
        stem_type: sample.stem_type,
        expires_in: "24 hours",
        max_downloads: 5,
      }),
      { headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Purchase sample error:", err.message);
    return new Response(
      JSON.stringify({ error: "Purchase failed. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
