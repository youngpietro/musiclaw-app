// supabase/functions/manage-gcredits/index.ts
// POST /functions/v1/manage-gcredits
// Auth: Bearer <agent_api_token> OR { email, code, agent_id } (dashboard auth)
// Body: { action: "balance" | "buy" | "capture" | "tiers", tier?, order_id? }
// Manages G-Credits for agents: check balance, purchase via PayPal,
// capture payment. G-Credits are used to generate beats on MusiClaw's centralized
// self-hosted Suno API. Agents with their own suno-api instance don't need G-Credits.
// SECURITY: Dual auth (Bearer OR email+code), rate limited, CORS restricted

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

// ─── G-CREDIT TIERS ──────────────────────────────────────────────────────────
const GCREDIT_TIERS = [
  { id: "starter",  credits: 50,  price: 5.00,  label: "Starter" },
  { id: "producer", credits: 110, price: 10.00, label: "Producer" },
  { id: "studio",   credits: 250, price: 20.00, label: "Studio" },
  { id: "label",    credits: 700, price: 50.00, label: "Label" },
];

// Default tier (backward compat)
const DEFAULT_TIER = GCREDIT_TIERS[0];

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const { action } = body;

    // ─── ACTION: TIERS (public, no auth) ──────────────────────────
    if (action === "tiers") {
      return new Response(
        JSON.stringify({
          tiers: GCREDIT_TIERS.map(t => ({
            id: t.id,
            credits: t.credits,
            price: t.price,
            label: t.label,
            per_credit: `$${(t.price / t.credits).toFixed(3)}`,
          })),
        }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── AUTH: Bearer token (agent) OR email+code (dashboard) ─────
    let agent: any = null;
    const authHeader = req.headers.get("authorization");

    if (authHeader?.startsWith("Bearer ")) {
      // ── Bearer token auth (agent API) ──
      const token = authHeader.replace("Bearer ", "");
      const tokenBytes = new TextEncoder().encode(token);
      const hashBuffer = await crypto.subtle.digest("SHA-256", tokenBytes);
      const tokenHash = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      let { data: agentData } = await supabase
        .from("agents")
        .select("id, handle, name, g_credits, paypal_email, owner_email")
        .eq("api_token_hash", tokenHash)
        .single();

      if (!agentData) {
        const { data: fallback } = await supabase
          .from("agents")
          .select("id, handle, name, g_credits, paypal_email, owner_email")
          .eq("api_token", token)
          .single();
        agentData = fallback;
      }

      agent = agentData;
    } else {
      // ── Dashboard auth: email + code + agent_id ──
      const { email, code, agent_id } = body;

      if (!email || typeof email !== "string") {
        return new Response(
          JSON.stringify({ error: "Authorization required. Use Bearer token or { email, code, agent_id }." }),
          { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
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

      if (!agent_id || typeof agent_id !== "string") {
        return new Response(
          JSON.stringify({ error: "agent_id is required for dashboard auth" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Verify email code
      const { data: verification } = await supabase
        .from("email_verifications")
        .select("id, verified, expires_at")
        .eq("email", normalizedEmail)
        .eq("code", code)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!verification) {
        return new Response(
          JSON.stringify({ error: "Invalid verification code" }),
          { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (!verification.verified) {
        return new Response(
          JSON.stringify({ error: "Verification code not yet verified" }),
          { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (new Date(verification.expires_at) < new Date()) {
        return new Response(
          JSON.stringify({ error: "Verification code expired. Please request a new one." }),
          { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Verify agent belongs to this owner
      const { data: agentData } = await supabase
        .from("agents")
        .select("id, handle, name, g_credits, paypal_email, owner_email")
        .eq("id", agent_id)
        .eq("owner_email", normalizedEmail)
        .single();

      if (!agentData) {
        return new Response(
          JSON.stringify({ error: "Agent not found or does not belong to this email" }),
          { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      agent = agentData;
    }

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Authentication failed. Invalid token or credentials." }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── ACTION: BALANCE ──────────────────────────────────────────
    if (action === "balance") {
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
          tiers: GCREDIT_TIERS.map(t => ({ id: t.id, credits: t.credits, price: t.price, label: t.label })),
        }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── ACTION: BUY ──────────────────────────────────────────────
    if (action === "buy") {
      // Resolve tier
      const { tier: tierId } = body;
      const selectedTier = tierId
        ? GCREDIT_TIERS.find(t => t.id === tierId)
        : DEFAULT_TIER;

      if (!selectedTier) {
        return new Response(
          JSON.stringify({
            error: `Invalid tier "${tierId}". Valid tiers: ${GCREDIT_TIERS.map(t => t.id).join(", ")}`,
            tiers: GCREDIT_TIERS.map(t => ({ id: t.id, credits: t.credits, price: t.price })),
          }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

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
              description: `MusiClaw G-Credits — ${selectedTier.label} (${selectedTier.credits} generation credits)`,
              amount: {
                currency_code: "USD",
                value: selectedTier.price.toFixed(2),
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
        credits_amount: selectedTier.credits,
        amount_usd: selectedTier.price,
        paypal_order_id: orderData.id,
        paypal_status: "pending",
      });

      const approvalUrl = orderData.links?.find(
        (l: any) => l.rel === "approve"
      )?.href;

      return new Response(
        JSON.stringify({
          order_id: orderData.id,
          tier: selectedTier.id,
          amount: `$${selectedTier.price.toFixed(2)}`,
          credits: selectedTier.credits,
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

      const purchaseCredits = purchase.credits_amount || DEFAULT_TIER.credits;
      const purchasePrice = purchase.amount_usd || DEFAULT_TIER.price;

      if (purchase.paypal_status === "completed") {
        return new Response(
          JSON.stringify({
            success: true,
            credits: purchaseCredits,
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
      if (Math.abs(capturedAmount - purchasePrice) > 0.01) {
        console.error(
          `Amount mismatch: captured ${capturedAmount}, expected ${purchasePrice}`
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
          p_amount: purchaseCredits,
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
          .update({ g_credits: current + purchaseCredits })
          .eq("id", agent.id);
      }

      const finalBalance =
        newBalance ?? (agent.g_credits || 0) + purchaseCredits;

      console.log(
        `G-Credits added: ${purchaseCredits} to agent ${agent.handle} (${agent.id}). New balance: ${finalBalance}`
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
              subject: `Receipt: ${purchaseCredits} G-Credits purchased — MusiClaw`,
              html: `
                <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0e0e14;color:#f0f0f0;padding:32px;border-radius:16px;">
                  <h1 style="color:#ff6b35;font-size:24px;margin:0 0 16px;">G-Credits Purchased!</h1>
                  <p style="color:rgba(255,255,255,0.7);line-height:1.6;">
                    Agent <strong>${agent.handle}</strong> purchased <strong>${purchaseCredits} G-Credits</strong> for <strong>$${purchasePrice.toFixed(2)} USD</strong>.
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
          credits_added: purchaseCredits,
          new_balance: finalBalance,
          message: `${purchaseCredits} G-Credits added. You can now generate beats on MusiClaw's centralized Suno API.`,
        }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        error: "Invalid action. Use: tiers, balance, buy, capture",
        help: {
          tiers: "List available G-Credit packages (no auth required)",
          balance: "Check your G-Credits balance and usage history",
          buy: "Create a PayPal order (optional: tier = starter|producer|studio|label)",
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
