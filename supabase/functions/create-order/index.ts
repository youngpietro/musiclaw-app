// supabase/functions/create-order/index.ts
// POST /functions/v1/create-order
// Body: { beat_id, buyer_email, tier? }
// Creates a PayPal order for purchasing a beat. No auth required (anonymous buyers).
// tier: "track" (WAV only, default) or "stems" (WAV + all stems)
// SECURITY: Price from DB (not client), CORS restricted, rate limited

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

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PayPal auth failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

// ─── TEST MODE: $0.01 for all tiers, no sold check ──────────────────────
const TEST_MODE = false;

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── RATE LIMITING: max 20 order creations per hour per IP ────────
    const clientIp =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("cf-connecting-ip") ||
      "unknown";

    const { data: recentOrders } = await supabase
      .from("rate_limits")
      .select("id")
      .eq("action", "create_order")
      .eq("identifier", clientIp)
      .gte("created_at", new Date(Date.now() - 3600000).toISOString());

    if (recentOrders && recentOrders.length >= 20) {
      return new Response(
        JSON.stringify({ error: "Too many purchase attempts. Try again later." }),
        { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("rate_limits").insert({
      action: "create_order",
      identifier: clientIp,
    });

    // ─── VALIDATE INPUT ───────────────────────────────────────────────
    const body = await req.json();
    const { beat_id, buyer_email } = body;
    const tier = body.tier === "stems" ? "stems" : "track"; // default to "track"

    if (!beat_id) {
      return new Response(
        JSON.stringify({ error: "beat_id is required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── VALIDATE BUYER EMAIL ─────────────────────────────────────────
    if (!buyer_email || typeof buyer_email !== "string") {
      return new Response(
        JSON.stringify({ error: "Email address is required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    const normalizedBuyerEmail = buyer_email.trim().toLowerCase();
    if (!emailRegex.test(normalizedBuyerEmail)) {
      return new Response(
        JSON.stringify({ error: "Invalid email address format" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── VERIFY EMAIL WAS CONFIRMED ──────────────────────────────────
    const { data: verification } = await supabase
      .from("email_verifications")
      .select("id, verified, created_at")
      .eq("email", normalizedBuyerEmail)
      .eq("verified", true)
      .gte("created_at", new Date(Date.now() - 30 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!verification) {
      return new Response(
        JSON.stringify({ error: "Email not verified. Please verify your email before purchasing." }),
        { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── LOOK UP BEAT (price comes from DB, never from client) ────────
    const { data: beat } = await supabase
      .from("beats")
      .select("id, title, genre, price, stems_price, stems_status, agent_id, status, sold, deleted_at, audio_url")
      .eq("id", beat_id)
      .single();

    if (!beat) {
      return new Response(
        JSON.stringify({ error: "Beat not found" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (!TEST_MODE && beat.sold === true) {
      return new Response(
        JSON.stringify({ error: "This beat has already been sold" }),
        { status: 410, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (beat.deleted_at) {
      return new Response(
        JSON.stringify({ error: "This beat has been removed by its creator" }),
        { status: 410, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (beat.status !== "complete") {
      return new Response(
        JSON.stringify({ error: "Beat is not yet available for purchase" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (!beat.audio_url) {
      return new Response(
        JSON.stringify({ error: "Beat audio is not available. Please try again later." }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (!TEST_MODE && (!beat.price || beat.price < 2.99)) {
      return new Response(
        JSON.stringify({ error: "This beat is not for sale" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── VALIDATE STEMS TIER ────────────────────────────────────────
    if (tier === "stems" && beat.stems_status !== "complete") {
      return new Response(
        JSON.stringify({ error: "Stems are not yet available for this beat. Please try again later or purchase the track only." }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── VERIFY AGENT HAS PAYPAL (live schema: paypal_email on agents) ─
    const { data: agent } = await supabase
      .from("agents")
      .select("handle, name, paypal_email, default_stems_price")
      .eq("id", beat.agent_id)
      .single();

    if (!agent?.paypal_email) {
      return new Response(
        JSON.stringify({ error: "This agent has not set up payment receiving yet" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ─── CALCULATE SPLIT (tier-aware) ─────────────────────────────────
    let totalAmount: number;
    if (tier === "stems") {
      // Stems tier: use beat.stems_price → agent.default_stems_price → 9.99
      totalAmount = parseFloat(beat.stems_price || agent?.default_stems_price || 9.99);
      if (totalAmount < 9.99) totalAmount = 9.99; // enforce minimum
    } else {
      totalAmount = parseFloat(beat.price);
    }
    // TEST MODE: override price to $0.01 for all tiers
    if (TEST_MODE) {
      totalAmount = 0.01;
      console.log(`TEST MODE: price overridden to $0.01 for beat ${beat.id} (tier: ${tier})`);
    }

    const platformAmount = Math.round(totalAmount * 20) / 100; // 20%
    const agentAmount = Math.round((totalAmount - platformAmount) * 100) / 100; // 80%

    // ─── CREATE PAYPAL ORDER ──────────────────────────────────────────
    const accessToken = await getPayPalAccessToken();
    const apiBase = Deno.env.get("PAYPAL_API_BASE") || "https://api-m.sandbox.paypal.com";

    const orderPayload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: beat.id,
          description: `${tier === "stems" ? "Beat + Stems" : "Beat"}: ${beat.title} by ${agent?.handle || "unknown"}`.slice(0, 127),
          amount: {
            currency_code: "USD",
            value: totalAmount.toFixed(2),
          },
        },
      ],
    };

    const orderRes = await fetch(`${apiBase}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(orderPayload),
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
    const orderId = orderData.id;

    // ─── RECORD PURCHASE IN DB ────────────────────────────────────────
    // Live schema uses: paypal_status, platform_fee, seller_paypal
    const { error: insertError } = await supabase.from("purchases").insert({
      beat_id: beat.id,
      buyer_email: normalizedBuyerEmail,
      paypal_order_id: orderId,
      amount: totalAmount,
      platform_fee: platformAmount,
      seller_paypal: agent.paypal_email,
      paypal_status: "pending",
      purchase_tier: tier,
    });

    if (insertError) throw insertError;

    return new Response(
      JSON.stringify({
        order_id: orderId,
        amount: totalAmount.toFixed(2),
        currency: "USD",
        tier,
      }),
      { status: 201, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Create order error:", err.message);
    return new Response(
      JSON.stringify({ error: "Failed to create order. Please try again." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
