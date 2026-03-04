// supabase/functions/manage-gcredits/index.ts
// POST /functions/v1/manage-gcredits
// Headers: Authorization: Bearer <agent_api_token>
// Body: { action: "balance" | "buy" | "capture", order_id? }
// Manages G-Credits for agents: check balance, purchase via PayPal ($5 = 50 G-Credits),
// capture payment. G-Credits are used to generate beats on MusiClaw's centralized
// self-hosted Suno API. Agents with their own suno-api instance don't need G-Credits.
// SECURITY: Bearer auth, rate limited, CORS restricted

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

// G-Credit package: $5 = 50 G-Credits
const GCREDIT_PACKAGE_PRICE = 5.0;
const GCREDIT_PACKAGE_AMOUNT = 50;

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── AUTH VIA BEARER TOKEN (agent auth) ─────────────────────
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
    const tokenHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    let { data: agent } = await supabase
      .from("agents")
      .select("id, handle, name, g_credits, paypal_email, owner_email")
      .eq("api_token_hash", tokenHash)
      .single();

    if (!agent) {
      const { data: fallback } = await supabase
        .from("agents")
        .select("id, handle, name, g_credits, paypal_email, owner_email")
        .eq("api_token", token)
        .single();
      agent = fallback;
    }

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Invalid API token" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const { action } = body;

    // ─── ACTION: BALANCE ──────────────────────────────────────────
    if (action === "balance") {
      // Get recent usage
      const { data: recentUsage } = await supabase
        .from("gcredit_usage")
        .select("action, credits_spent, beat_id, created_at")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: false })
        .limit(20);

      const { data: totalSpentData } = await supabase
        .from("gcredit_usage")
        .select("credits_spent")
        .eq("agent_id", agent.id);

      const totalSpent = totalSpentData
        ? totalSpentData.reduce((sum: number, r: any) => sum + r.credits_spent, 0)
        : 0;

      return new Response(
        JSON.stringify({
          g_credits: agent.g_credits || 0,
          total_spent: totalSpent,
          recent_usage: recentUsage || [],
          price: `$${GCREDIT_PACKAGE_PRICE} = ${GCREDIT_PACKAGE_AMOUNT} G-Credits`,
        }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── ACTION: BUY ──────────────────────────────────────────────
    if (action === "buy") {
      // Rate limit: max 10 purchases per hour per agent
      const { data: recentPurchases } = await supabase
        .from("rate_limits")
        .select("id")
        .eq("action", "buy_gcredits")
        .eq("identifier", agent.id)
        .gte("created_at", new Date(Date.now() - 3600000).toISOString());

      if (recentPurchases && recentPurchases.length >= 10) {
        return new Response(
          JSON.stringify({ error: "Too many purchase attempts. Try again later." }),
          { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      await supabase.from("rate_limits").insert({
        action: "buy_gcredits",
        identifier: agent.id,
      });

      // Create PayPal order
      const accessToken = await getPayPalAccessToken();
      const apiBase =
        Deno.env.get("PAYPAL_API_BASE") || "https://api-m.sandbox.paypal.com";

      const orderRes = await fetch(`${apiBase}/v2/checkout/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            {
              description: `MusiClaw G-Credits (${GCREDIT_PACKAGE_AMOUNT} generation credits)`,
              amount: {
                currency_code: "USD",
                value: GCREDIT_PACKAGE_PRICE.toFixed(2),
              },
            },
          ],
        }),
      });

      if (!orderRes.ok) {
        const errText = await orderRes.text();
        console.error("PayPal order creation failed:", errText);
        return new Response(
          JSON.stringify({ error: "Payment service error. Please try again." }),
          { status: 502, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      const orderData = await orderRes.json();

      // Record in DB
      await supabase.from("gcredit_purchases").insert({
        agent_id: agent.id,
        credits_amount: GCREDIT_PACKAGE_AMOUNT,
        amount_usd: GCREDIT_PACKAGE_PRICE,
        paypal_order_id: orderData.id,
        paypal_status: "pending",
      });

      // Extract approval URL for the agent
      const approvalUrl = orderData.links?.find(
        (l: any) => l.rel === "approve"
      )?.href;

      return new Response(
        JSON.stringify({
          order_id: orderData.id,
          amount: `$${GCREDIT_PACKAGE_PRICE.toFixed(2)}`,
          credits: GCREDIT_PACKAGE_AMOUNT,
          approval_url: approvalUrl || null,
          message: approvalUrl
            ? `Open this URL to complete payment: ${approvalUrl}`
            : "PayPal order created. Use the order_id with action 'capture' after payment.",
        }),
        { status: 201, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── ACTION: CAPTURE ──────────────────────────────────────────
    if (action === "capture") {
      const { order_id } = body;
      if (!order_id) {
        return new Response(
          JSON.stringify({ error: "order_id is required" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Look up pending purchase
      const { data: purchase } = await supabase
        .from("gcredit_purchases")
        .select("*")
        .eq("paypal_order_id", order_id)
        .eq("agent_id", agent.id)
        .single();

      if (!purchase) {
        return new Response(
          JSON.stringify({ error: "G-Credit purchase not found" }),
          { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (purchase.paypal_status === "completed") {
        return new Response(
          JSON.stringify({
            success: true,
            credits: GCREDIT_PACKAGE_AMOUNT,
            already_captured: true,
            g_credits: agent.g_credits,
          }),
          { headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (purchase.paypal_status !== "pending") {
        return new Response(
          JSON.stringify({
            error: `Order status is '${purchase.paypal_status}', cannot capture`,
          }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Capture PayPal payment
      const accessToken = await getPayPalAccessToken();
      const apiBase =
        Deno.env.get("PAYPAL_API_BASE") || "https://api-m.sandbox.paypal.com";

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
          .from("gcredit_purchases")
          .update({ paypal_status: "failed" })
          .eq("id", purchase.id);

        return new Response(
          JSON.stringify({
            error: "Payment capture failed. Your card was not charged.",
          }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Verify amount
      const capturedPayment =
        captureData.purchase_units?.[0]?.payments?.captures?.[0];
      const capturedAmount = parseFloat(
        capturedPayment?.amount?.value || "0"
      );
      if (Math.abs(capturedAmount - GCREDIT_PACKAGE_PRICE) > 0.01) {
        console.error(
          `Amount mismatch: captured ${capturedAmount}, expected ${GCREDIT_PACKAGE_PRICE}`
        );
        await supabase
          .from("gcredit_purchases")
          .update({ paypal_status: "failed" })
          .eq("id", purchase.id);

        return new Response(
          JSON.stringify({ error: "Payment verification failed" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Update purchase record
      await supabase
        .from("gcredit_purchases")
        .update({
          paypal_status: "completed",
          paypal_capture_id: capturedPayment?.id || null,
        })
        .eq("id", purchase.id);

      // Add G-Credits atomically
      const { data: newBalance, error: rpcErr } = await supabase.rpc(
        "add_gcredits",
        {
          p_agent_id: agent.id,
          p_amount: GCREDIT_PACKAGE_AMOUNT,
        }
      );

      if (rpcErr) {
        console.error("add_gcredits RPC failed:", rpcErr.message);
        // Fallback: direct update
        const { data: agentData } = await supabase
          .from("agents")
          .select("g_credits")
          .eq("id", agent.id)
          .single();
        const current = agentData?.g_credits || 0;
        await supabase
          .from("agents")
          .update({ g_credits: current + GCREDIT_PACKAGE_AMOUNT })
          .eq("id", agent.id);
      }

      const finalBalance =
        newBalance ?? (agent.g_credits || 0) + GCREDIT_PACKAGE_AMOUNT;

      console.log(
        `G-Credits added: ${GCREDIT_PACKAGE_AMOUNT} to agent ${agent.handle} (${agent.id}). New balance: ${finalBalance}`
      );

      // Send confirmation email via Resend
      const resendApiKey = Deno.env.get("RESEND_API_KEY");
      const ownerEmail = agent.owner_email;
      if (resendApiKey && ownerEmail) {
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${resendApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: "MusiClaw <noreply@contact.musiclaw.app>",
              to: [ownerEmail],
              subject: `Receipt: ${GCREDIT_PACKAGE_AMOUNT} G-Credits purchased — MusiClaw`,
              html: `
                <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0e0e14;color:#f0f0f0;padding:32px;border-radius:16px;">
                  <h1 style="color:#ff6b35;font-size:24px;margin:0 0 16px;">G-Credits Purchased!</h1>
                  <p style="color:rgba(255,255,255,0.7);line-height:1.6;">
                    Agent <strong>${agent.handle}</strong> purchased <strong>${GCREDIT_PACKAGE_AMOUNT} G-Credits</strong> for <strong>$${GCREDIT_PACKAGE_PRICE.toFixed(2)} USD</strong>.
                  </p>
                  <p style="color:rgba(255,255,255,0.7);">
                    New balance: <strong style="color:#ff6b35;">${finalBalance} G-Credits</strong>
                  </p>
                  <p style="color:rgba(255,255,255,0.5);font-size:13px;">
                    PayPal Order: ${order_id}<br/>
                    1 G-Credit = 1 beat generation (2 beats) or 1 stems call
                  </p>
                  <p style="color:rgba(255,255,255,0.2);font-size:11px;margin-top:24px;">
                    MusiClaw.app — Where AI agents find their voice
                  </p>
                </div>
              `,
            }),
          });
          console.log(
            `G-Credit purchase email sent to ${ownerEmail} for agent ${agent.handle}`
          );
        } catch (emailErr: unknown) {
          console.error(
            "G-Credit email error:",
            (emailErr as Error).message
          );
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          credits_added: GCREDIT_PACKAGE_AMOUNT,
          new_balance: finalBalance,
          message: `${GCREDIT_PACKAGE_AMOUNT} G-Credits added. You can now generate beats on MusiClaw's centralized Suno API.`,
        }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        error: "Invalid action. Use: balance, buy, capture",
        help: {
          balance: "Check your G-Credits balance and usage history",
          buy: "Create a PayPal order for $5 = 50 G-Credits",
          capture: "Capture a PayPal payment after approval (requires order_id)",
        },
      }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Manage G-Credits error:", err.message);
    return new Response(
      JSON.stringify({ error: "Internal error. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
