// supabase/functions/capture-order/index.ts
// POST /functions/v1/capture-order
// Body: { order_id }
// Captures a PayPal payment and returns a signed download URL.
// SECURITY: Verifies payment with PayPal API, HMAC-signed download tokens

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

async function getPayPalAccessToken(): Promise<string> {
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID")!;
  const clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET")!;
  const apiBase = Deno.env.get("PAYPAL_API_BASE") || "https://api-m.sandbox.paypal.com";

  const res = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
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
  // Base64url encode
  const bytes = new Uint8Array(signature);
  let b64 = btoa(String.fromCharCode(...bytes));
  b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b64;
}

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const signingSecret = Deno.env.get("DOWNLOAD_SIGNING_SECRET");
    if (!signingSecret) {
      console.error("DOWNLOAD_SIGNING_SECRET not configured");
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── RATE LIMITING: max 20 capture attempts per hour per IP ───────
    const clientIp =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("cf-connecting-ip") ||
      "unknown";

    const { data: recentCaptures } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "capture_order")
      .eq("identifier", clientIp)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentCaptures && recentCaptures.length >= 20) {
      return new Response(
        JSON.stringify({ error: "Too many attempts. Try again later." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({
      action: "capture_order",
      identifier: clientIp,
    });

    // ─── VALIDATE INPUT ───────────────────────────────────────────────
    const body = await req.json();
    const { order_id } = body;

    if (!order_id || typeof order_id !== "string") {
      return new Response(
        JSON.stringify({ error: "order_id is required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP PURCHASE ─────────────────────────────────────────────
    const { data: purchase } = await supabase
      .from("purchases")
      .select("*")
      .eq("paypal_order_id", order_id)
      .single();

    if (!purchase) {
      return new Response(
        JSON.stringify({ error: "Order not found" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (purchase.paypal_status === "completed") {
      // Already captured — return existing download URL if still valid
      if (purchase.download_expires && new Date(purchase.download_expires) > new Date()) {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        return new Response(
          JSON.stringify({
            success: true,
            download_url: `${supabaseUrl}/functions/v1/download-beat?token=${purchase.download_token}`,
            already_captured: true,
          }),
          { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ error: "Payment already captured and download link has expired" }),
        { status: 410, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (purchase.paypal_status !== "pending") {
      return new Response(
        JSON.stringify({ error: `Order status is '${purchase.paypal_status}', cannot capture` }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── CAPTURE PAYPAL ORDER ─────────────────────────────────────────
    const accessToken = await getPayPalAccessToken();
    const apiBase = Deno.env.get("PAYPAL_API_BASE") || "https://api-m.sandbox.paypal.com";

    const captureRes = await fetch(
      `${apiBase}/v2/checkout/orders/${order_id}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const captureData = await captureRes.json();

    if (!captureRes.ok || captureData.status !== "COMPLETED") {
      console.error("PayPal capture failed:", JSON.stringify(captureData));

      await supabase
        .from("purchases")
        .update({ paypal_status: "failed" })
        .eq("id", purchase.id);

      return new Response(
        JSON.stringify({ error: "Payment capture failed. Your card was not charged." }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── VERIFY CAPTURED AMOUNT ───────────────────────────────────────
    const capturedUnit = captureData.purchase_units?.[0];
    const capturedPayment = capturedUnit?.payments?.captures?.[0];
    const capturedAmount = parseFloat(capturedPayment?.amount?.value || "0");
    const expectedAmount = parseFloat(purchase.amount);

    if (Math.abs(capturedAmount - expectedAmount) > 0.01) {
      console.error(
        `Amount mismatch: captured ${capturedAmount}, expected ${expectedAmount}`
      );
      await supabase
        .from("purchases")
        .update({ paypal_status: "failed" })
        .eq("id", purchase.id);

      return new Response(
        JSON.stringify({ error: "Payment verification failed" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── GENERATE SIGNED DOWNLOAD TOKEN ───────────────────────────────
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    const payload = `${purchase.id}:${purchase.beat_id}:${expiresAt.toISOString()}`;
    const signature = await hmacSign(payload, signingSecret);
    const downloadToken = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") +
      "." + signature;

    // ─── UPDATE PURCHASE RECORD ───────────────────────────────────────
    const captureId = capturedPayment?.id || null;
    const buyerEmail =
      captureData.payer?.email_address || captureData.payment_source?.paypal?.email_address || null;

    await supabase
      .from("purchases")
      .update({
        paypal_status: "completed",
        paypal_capture_id: captureId,
        buyer_email: buyerEmail,
        download_token: downloadToken,
        download_expires: expiresAt.toISOString(),
        captured_at: new Date().toISOString(),
      })
      .eq("id", purchase.id);

    // ─── AWARD KARMA TO AGENT ─────────────────────────────────────────
    const { data: beat } = await supabase
      .from("beats")
      .select("agent_id, title")
      .eq("id", purchase.beat_id)
      .single();

    if (beat) {
      const { data: agent } = await supabase
        .from("agents")
        .select("karma")
        .eq("id", beat.agent_id)
        .single();

      if (agent) {
        await supabase
          .from("agents")
          .update({ karma: agent.karma + 10 })
          .eq("id", beat.agent_id);
      }
    }

    // ─── MARK BEAT AS SOLD (one-time exclusive) ──────────────────────
    await supabase
      .from("beats")
      .update({ sold: true })
      .eq("id", purchase.beat_id)
      .eq("sold", false); // Only update if not already sold (race condition protection)

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const downloadUrl = `${supabaseUrl}/functions/v1/download-beat?token=${encodeURIComponent(downloadToken)}`;

    // ─── SEND DOWNLOAD EMAIL VIA RESEND ──────────────────────────────
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const recipientEmail = buyerEmail || purchase.buyer_email;
    if (resendApiKey && recipientEmail) {
      try {
        const beatTitle = beat?.title || "Beat";
        const emailRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "MusiClaw <noreply@musiclaw.app>",
            to: [recipientEmail],
            subject: `Your beat is ready: ${beatTitle} - MusiClaw`,
            html: `
              <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0e0e14;color:#f0f0f0;padding:32px;border-radius:16px;">
                <h1 style="color:#22c55e;font-size:24px;margin:0 0 16px;">Purchase Complete!</h1>
                <p style="color:rgba(255,255,255,0.7);line-height:1.6;">
                  Thank you for your purchase. Your beat <strong>&ldquo;${beatTitle}&rdquo;</strong> is ready to download.
                </p>
                <a href="${downloadUrl}" style="display:inline-block;background:#22c55e;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;margin:20px 0;">
                  Download .mp3
                </a>
                <p style="color:rgba(255,255,255,0.35);font-size:12px;margin-top:24px;">
                  This link expires in 24 hours. Maximum 5 downloads.<br/>
                  Every AI-generated beat includes a commercial license.
                </p>
                <p style="color:rgba(255,255,255,0.2);font-size:11px;margin-top:16px;">
                  MusiClaw.app &mdash; Where AI agents find their voice
                </p>
              </div>
            `,
          }),
        });
        if (!emailRes.ok) {
          console.error("Resend email failed:", await emailRes.text());
        }
      } catch (emailErr) {
        console.error("Email send error:", emailErr.message);
        // Non-fatal: purchase succeeded even if email fails
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        download_url: downloadUrl,
        expires_in: "24 hours",
        max_downloads: 5,
      }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Capture order error:", err.message);
    return new Response(
      JSON.stringify({ error: "Payment processing failed. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
