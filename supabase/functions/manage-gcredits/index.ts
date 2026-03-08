// supabase/functions/manage-gcredits/index.ts
// POST /functions/v1/manage-gcredits
// Auth: Bearer <agent_api_token> OR { email, code } (dashboard auth)
// Body: { action: "balance" | "buy" | "capture" | "tiers", tier?, order_id?, agent_id? }
// Manages G-Credits at the OWNER (email) level — all agents under the same
// owner_email share one G-Credits pool. Credits are used to generate beats
// on MusiClaw's centralized self-hosted Suno API.
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

const DEFAULT_TIER = GCREDIT_TIERS[0];

// Helper: get owner G-Credits balance from owner_gcredits table
async function getOwnerBalance(supabase: any, ownerEmail: string): Promise<number> {
  const { data } = await supabase
    .from("owner_gcredits")
    .select("g_credits")
    .eq("owner_email", ownerEmail.trim().toLowerCase())
    .single();
  return data?.g_credits ?? 0;
}

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
    let ownerEmail: string = "";
    let agentForTracking: any = null; // optional, for purchase attribution

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
        .select("id, handle, name, owner_email")
        .eq("api_token_hash", tokenHash)
        .single();

      if (!agentData) {
        const { data: fallback } = await supabase
          .from("agents")
          .select("id, handle, name, owner_email")
          .eq("api_token", token)
          .single();
        agentData = fallback;
      }

      if (!agentData || !agentData.owner_email) {
        return new Response(
          JSON.stringify({ error: "Authentication failed. Invalid API token." }),
          { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      ownerEmail = agentData.owner_email.trim().toLowerCase();
      agentForTracking = agentData;
    } else {
      // ── Dashboard auth: email + code ──
      const { email, code, agent_id } = body;

      if (!email || typeof email !== "string") {
        return new Response(
          JSON.stringify({ error: "Authorization required. Provide Bearer token or { email, code }." }),
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

      ownerEmail = normalizedEmail;

      // If agent_id provided, load for tracking (optional, not required)
      if (agent_id && typeof agent_id === "string") {
        const { data: agentData } = await supabase
          .from("agents")
          .select("id, handle, name, owner_email")
          .eq("id", agent_id)
          .eq("owner_email", normalizedEmail)
          .single();
        agentForTracking = agentData || null;
      }
    }

    if (!ownerEmail) {
      return new Response(
        JSON.stringify({ error: "Authentication failed." }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── ACTION: BALANCE ──────────────────────────────────────────
    if (action === "balance") {
      const ownerBalance = await getOwnerBalance(supabase, ownerEmail);

      // Get usage across ALL agents for this owner
      const { data: ownerAgents } = await supabase
        .from("agents")
        .select("id")
        .eq("owner_email", ownerEmail);

      const agentIds = (ownerAgents || []).map((a: any) => a.id);

      let totalSpent = 0;
      let recentUsage: any[] = [];

      if (agentIds.length > 0) {
        const { data: usageData } = await supabase
          .from("gcredit_usage")
          .select("credits_spent")
          .in("agent_id", agentIds);

        totalSpent = usageData
          ? usageData.reduce((sum: number, r: any) => sum + r.credits_spent, 0)
          : 0;

        const { data: recentData } = await supabase
          .from("gcredit_usage")
          .select("action, credits_spent, beat_id, agent_id, created_at")
          .in("agent_id", agentIds)
          .order("created_at", { ascending: false })
          .limit(20);

        recentUsage = recentData || [];
      }

      return new Response(
        JSON.stringify({
          g_credits: ownerBalance,
          owner_email: ownerEmail,
          total_spent: totalSpent,
          recent_usage: recentUsage,
          tiers: GCREDIT_TIERS.map(t => ({ id: t.id, credits: t.credits, price: t.price, label: t.label })),
        }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── ACTION: BUY ──────────────────────────────────────────────
    if (action === "buy") {
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

      // Rate limit: max 10 purchases per hour per owner email
      const { data: recentPurchases } = await supabase
        .from("rate_limits")
        .select("id")
        .eq("action", "buy_gcredits")
        .eq("identifier", ownerEmail)
        .gte("created_at", new Date(Date.now() - 3600000).toISOString());

      if (recentPurchases && recentPurchases.length >= 10) {
        return new Response(
          JSON.stringify({ error: "Too many purchase attempts. Try again later." }),
          { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      await supabase.from("rate_limits").insert({
        action: "buy_gcredits",
        identifier: ownerEmail,
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

      // Record in DB (agent_id is optional, for attribution)
      await supabase.from("gcredit_purchases").insert({
        agent_id: agentForTracking?.id || null,
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

      // Look up pending purchase (match by order_id only — owner verified via auth)
      const { data: purchase } = await supabase
        .from("gcredit_purchases")
        .select("*")
        .eq("paypal_order_id", order_id)
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
        const bal = await getOwnerBalance(supabase, ownerEmail);
        return new Response(
          JSON.stringify({
            success: true,
            credits: purchaseCredits,
            already_captured: true,
            new_balance: bal,
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

      // Add G-Credits to OWNER pool (per-email)
      const { data: newBalance, error: rpcErr } = await supabase.rpc(
        "add_owner_gcredits",
        {
          p_email: ownerEmail,
          p_amount: purchaseCredits,
        }
      );

      if (rpcErr) {
        console.error("add_owner_gcredits RPC failed:", rpcErr.message);
        // Fallback: direct upsert
        const currentBal = await getOwnerBalance(supabase, ownerEmail);
        await supabase
          .from("owner_gcredits")
          .upsert({
            owner_email: ownerEmail,
            g_credits: currentBal + purchaseCredits,
            updated_at: new Date().toISOString(),
          });
      }

      const finalBalance =
        newBalance ?? (await getOwnerBalance(supabase, ownerEmail));

      console.log(
        `G-Credits added: ${purchaseCredits} to owner ${ownerEmail}. New balance: ${finalBalance}`
      );

      // Send confirmation email via Resend
      const resendApiKey = Deno.env.get("RESEND_API_KEY");
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
                    You purchased <strong>${purchaseCredits} G-Credits</strong> for <strong>$${purchasePrice.toFixed(2)} USD</strong>.
                  </p>
                  <p style="color:rgba(255,255,255,0.7);">
                    New balance: <strong style="color:#ff6b35;">${finalBalance} G-Credits</strong>
                  </p>
                  <p style="color:rgba(255,255,255,0.5);font-size:13px;">
                    All your agents share this G-Credits pool.<br/>
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
          console.log(`G-Credit purchase email sent to ${ownerEmail}`);
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
          owner_email: ownerEmail,
          message: `${purchaseCredits} G-Credits added to your account. All your agents can now generate beats.`,
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
