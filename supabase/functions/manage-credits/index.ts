// supabase/functions/manage-credits/index.ts
// POST /functions/v1/manage-credits
// Body: { action: "balance" | "buy" | "capture", order_id? }
// Manages user credits: check balance, purchase via PayPal ($5 = 100 credits), capture payment
// SECURITY: Requires Supabase Auth JWT, rate limited, CORS restricted

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

// Credit package: $5 = 100 credits
const CREDIT_PACKAGE_PRICE = 5.0;
const CREDIT_PACKAGE_AMOUNT = 100;

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // ─── AUTHENTICATE USER VIA JWT ──────────────────────────────────
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Authentication required. Please log in." }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Use anon key client to verify the user's JWT
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

    // Service role client for DB operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const { action } = body;

    // ─── ACTION: BALANCE ────────────────────────────────────────────
    if (action === "balance") {
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("credit_balance")
        .eq("id", user.id)
        .single();

      return new Response(
        JSON.stringify({ credits: profile?.credit_balance || 0 }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── ACTION: BUY ────────────────────────────────────────────────
    if (action === "buy") {
      // Rate limit: max 10 credit purchases per hour per user
      const { data: recentPurchases } = await supabase
        .from("rate_limits")
        .select("id")
        .eq("action", "buy_credits")
        .eq("identifier", user.id)
        .gte("created_at", new Date(Date.now() - 3600000).toISOString());

      if (recentPurchases && recentPurchases.length >= 10) {
        return new Response(
          JSON.stringify({ error: "Too many purchase attempts. Try again later." }),
          { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      await supabase.from("rate_limits").insert({
        action: "buy_credits",
        identifier: user.id,
      });

      // Create PayPal order
      const accessToken = await getPayPalAccessToken();
      const apiBase = Deno.env.get("PAYPAL_API_BASE") || "https://api-m.sandbox.paypal.com";

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
              description: `MusiClaw Sample Credits (${CREDIT_PACKAGE_AMOUNT} credits)`,
              amount: {
                currency_code: "USD",
                value: CREDIT_PACKAGE_PRICE.toFixed(2),
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
      await supabase.from("credit_purchases").insert({
        user_id: user.id,
        credits_amount: CREDIT_PACKAGE_AMOUNT,
        amount_usd: CREDIT_PACKAGE_PRICE,
        paypal_order_id: orderData.id,
        paypal_status: "pending",
      });

      return new Response(
        JSON.stringify({
          order_id: orderData.id,
          amount: CREDIT_PACKAGE_PRICE.toFixed(2),
          credits: CREDIT_PACKAGE_AMOUNT,
        }),
        { status: 201, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── ACTION: CAPTURE ────────────────────────────────────────────
    if (action === "capture") {
      const { order_id } = body;
      if (!order_id) {
        return new Response(
          JSON.stringify({ error: "order_id is required" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Look up pending credit purchase
      const { data: creditPurchase } = await supabase
        .from("credit_purchases")
        .select("*")
        .eq("paypal_order_id", order_id)
        .eq("user_id", user.id)
        .single();

      if (!creditPurchase) {
        return new Response(
          JSON.stringify({ error: "Credit purchase not found" }),
          { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (creditPurchase.paypal_status === "completed") {
        return new Response(
          JSON.stringify({ success: true, credits: CREDIT_PACKAGE_AMOUNT, already_captured: true }),
          { headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (creditPurchase.paypal_status !== "pending") {
        return new Response(
          JSON.stringify({ error: `Order status is '${creditPurchase.paypal_status}', cannot capture` }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Capture PayPal payment
      const accessToken = await getPayPalAccessToken();
      const apiBase = Deno.env.get("PAYPAL_API_BASE") || "https://api-m.sandbox.paypal.com";

      const captureRes = await fetch(`${apiBase}/v2/checkout/orders/${order_id}/capture`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      const captureData = await captureRes.json();

      if (!captureRes.ok || captureData.status !== "COMPLETED") {
        console.error("PayPal capture failed:", JSON.stringify(captureData));
        await supabase
          .from("credit_purchases")
          .update({ paypal_status: "failed" })
          .eq("id", creditPurchase.id);

        return new Response(
          JSON.stringify({ error: "Payment capture failed. Your card was not charged." }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Verify amount
      const capturedPayment = captureData.purchase_units?.[0]?.payments?.captures?.[0];
      const capturedAmount = parseFloat(capturedPayment?.amount?.value || "0");
      if (Math.abs(capturedAmount - CREDIT_PACKAGE_PRICE) > 0.01) {
        console.error(`Amount mismatch: captured ${capturedAmount}, expected ${CREDIT_PACKAGE_PRICE}`);
        await supabase
          .from("credit_purchases")
          .update({ paypal_status: "failed" })
          .eq("id", creditPurchase.id);

        return new Response(
          JSON.stringify({ error: "Payment verification failed" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      // Update credit purchase record
      await supabase
        .from("credit_purchases")
        .update({
          paypal_status: "completed",
          paypal_capture_id: capturedPayment?.id || null,
        })
        .eq("id", creditPurchase.id);

      // Add credits to user profile
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("credit_balance")
        .eq("id", user.id)
        .single();

      const currentBalance = profile?.credit_balance || 0;
      await supabase
        .from("user_profiles")
        .update({
          credit_balance: currentBalance + CREDIT_PACKAGE_AMOUNT,
          updated_at: new Date().toISOString(),
        })
        .eq("id", user.id);

      console.log(`Credits added: ${CREDIT_PACKAGE_AMOUNT} credits to user ${user.id} (new balance: ${currentBalance + CREDIT_PACKAGE_AMOUNT})`);

      return new Response(
        JSON.stringify({
          success: true,
          credits_added: CREDIT_PACKAGE_AMOUNT,
          new_balance: currentBalance + CREDIT_PACKAGE_AMOUNT,
        }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid action. Use: balance, buy, capture" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Manage credits error:", err.message);
    return new Response(
      JSON.stringify({ error: "Internal error. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
